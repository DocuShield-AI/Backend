import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { RefreshTokenStore } from './refresh-token.store';
import { RoleInvalidationStore } from './role-invalidation.store';
import {
  JwtPayload,
  OAuthProfile,
  RefreshTokenPayload,
  TokenPair,
} from '../auth.types';
import { LoginDto } from '../dto/login.dto';
import { SignupDto } from '../dto/signup.dto';

export interface AuthResult extends TokenPair {
  user: { id: string; email: string; role: Role; workspaceId: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenStore,
    private readonly roleInvalidations: RoleInvalidationStore,
  ) {}

  // A user cannot exist without a workspace (non-null FK), so both are created
  // atomically.
  async signup(dto: SignupDto): Promise<AuthResult> {
    return dto.type === 'join'
      ? this.joinWorkspaceWithInvite({
          code: dto.inviteCode,
          email: dto.email,
          passwordHash: await this.password.hash(dto.password),
        })
      : this.createWorkspaceSignup(dto);
  }

  private async createWorkspaceSignup(dto: SignupDto): Promise<AuthResult> {
    if (!dto.workspaceName) {
      throw new BadRequestException(
        'A workspace name is required to create a company',
      );
    }
    const workspaceName: string = dto.workspaceName;
    const passwordHash = await this.password.hash(dto.password);

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: workspaceName },
        });
        return tx.user.create({
          data: {
            workspaceId: workspace.id,
            email: dto.email.toLowerCase(),
            passwordHash,
            // First account in a workspace owns it.
            role: Role.admin,
          },
        });
      });
    } catch (err) {
      // Unique index, not a pre-check: two concurrent signups for one email
      // cannot both pass a lookup and then collide.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }

    this.logger.log(`Signup: user ${user.id} created workspace ${user.workspaceId}`);
    return this.buildResult(user);
  }

  /**
   * Adds a user to an existing workspace via a single-use invite. The invite is
   * claimed atomically inside the same transaction that creates the user:
   * `updateMany(where usedAt: null)` is the only consumer-wins primitive, so two
   * simultaneous joins with the same code cannot both succeed.
   */
  private async joinWorkspaceWithInvite(args: {
    code?: string;
    email: string;
    passwordHash: string;
    oauthProvider?: string;
  }): Promise<AuthResult> {
    const code = args.code?.trim();
    if (!code) {
      throw new BadRequestException('An invite code is required to join a company');
    }

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const invite = await tx.invitation.findUnique({ where: { code } });
        if (!invite) {
          throw new BadRequestException('Invalid invite code');
        }
        if (invite.expiresAt < new Date()) {
          throw new BadRequestException('Invite code has expired');
        }

        // Claim before creating the user; 0 matched rows means another join won.
        const claimed = await tx.invitation.updateMany({
          where: { id: invite.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Invite code has already been used');
        }

        const created = await tx.user.create({
          data: {
            workspaceId: invite.workspaceId,
            email: args.email.toLowerCase(),
            passwordHash: args.passwordHash,
            role: invite.role,
            oauthProvider: args.oauthProvider ?? null,
          },
        });
        await tx.invitation.update({
          where: { id: invite.id },
          data: { usedByUserId: created.id },
        });
        return created;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }

    this.logger.log(
      `Signup (join): user ${user.id} joined workspace ${user.workspaceId} as ${user.role}`,
    );
    return this.buildResult(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Same message for both cases, so logins cannot be used to enumerate emails.
    const ok =
      user !== null &&
      (await this.password.compare(dto.password, user.passwordHash));
    if (!ok || !user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildResult(user);
  }

  /**
   * Exchanges a refresh token for a fresh pair and retires the one presented,
   * so each token is usable exactly once. A token that was already rotated away
   * and reappears cannot come from a well-behaved client — treat it as leaked
   * and drop every session for the user. A merely unknown token is just a
   * stale client.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);

    if (!(await this.refreshTokens.isValid(payload.sub, payload.jti))) {
      if (await this.refreshTokens.wasSpent(payload.sub, payload.jti)) {
        this.logger.warn(
          `Refresh-token replay detected for user ${payload.sub}; revoking all sessions`,
        );
        await this.refreshTokens.revokeAll(payload.sub);
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Re-read the user so a deleted account, or a role change, cannot keep
    // refreshing on claims baked into an old token.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      await this.refreshTokens.revokeAll(payload.sub);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Retire before issuing, so a crash in between leaves the old token dead
    // rather than leaving two live tokens behind.
    await this.refreshTokens.retire(
      payload.sub,
      payload.jti,
      this.secondsUntil(payload.exp),
    );
    return this.issueTokens(user);
  }

  /**
   * Signs in through an OAuth provider, creating the account on first visit.
   * Matching by email is safe only because the strategy rejects unverified
   * addresses. First-time visitors carrying an invite join that team instead
   * of spawning a new workspace.
   */
  async validateOAuthLogin(
    profile: OAuthProfile,
    inviteCode?: string,
  ): Promise<AuthResult> {
    const email = profile.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      // Attach the provider on the first OAuth login; the password keeps working.
      const user = existing.oauthProvider
        ? existing
        : await this.prisma.user.update({
            where: { id: existing.id },
            data: { oauthProvider: profile.provider },
          });
      this.logger.log(`OAuth login: user ${user.id} via ${profile.provider}`);
      return this.buildResult(user);
    }

    if (inviteCode) {
      // Hash of a value nobody holds: the password route stays closed for this
      // account until a real reset.
      return this.joinWorkspaceWithInvite({
        code: inviteCode,
        email,
        passwordHash: await this.password.hash(`${randomUUID()}${randomUUID()}`),
        oauthProvider: profile.provider,
      });
    }

    const passwordHash = await this.password.hash(`${randomUUID()}${randomUUID()}`);
    const user = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: `${profile.displayName ?? email.split('@')[0]}'s workspace` },
      });
      return tx.user.create({
        data: {
          workspaceId: workspace.id,
          email,
          passwordHash,
          role: Role.admin,
          oauthProvider: profile.provider,
        },
      });
    });

    this.logger.log(
      `OAuth signup: user ${user.id} created workspace ${user.workspaceId} via ${profile.provider}`,
    );
    return this.buildResult(user);
  }

  /** Ends one session. Other devices keep working. */
  async logout(refreshToken: string): Promise<void> {
    const payload = await this.verifyRefreshToken(refreshToken);
    await this.refreshTokens.forget(payload.sub, payload.jti);
    this.logger.log(`Logout: session ${payload.jti} revoked for user ${payload.sub}`);
  }

  private async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
      if (!payload?.jti) {
        throw new Error('Refresh token carries no id');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private async buildResult(user: User): Promise<AuthResult> {
    const tokens = await this.issueTokens(user);
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        workspaceId: user.workspaceId,
      },
    };
  }

  /**
   * Access and refresh tokens are signed with separate secrets, so a leaked
   * access token cannot be replayed against the refresh endpoint. Only the
   * refresh token is recorded server-side; the access token stays stateless
   * (its ~15m lifetime is the bound).
   */
  private async issueTokens(user: User): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
      email: user.email,
    };
    const jti = randomUUID();

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload),
      this.jwt.signAsync(
        { ...payload, jti },
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: (this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ??
            '7d') as JwtSignOptions['expiresIn'],
        },
      ),
    ]);

    // The token's own `exp` decides the record's TTL so the two never drift apart.
    const decoded = this.jwt.decode(refreshToken) as RefreshTokenPayload | null;
    await this.refreshTokens.remember(
      user.id,
      jti,
      this.secondsUntil(decoded?.exp ?? 0),
    );

    // A fresh token pair carries the current role in its claims, so any
    // "role changed, re-read the DB" flag from earlier is now redundant.
    await this.roleInvalidations.clear(user.id);

    return { accessToken, refreshToken };
  }

  /** Seconds left on a token, floored at 1 so Redis never gets a stale TTL. */
  private secondsUntil(expEpochSeconds: number): number {
    return Math.max(1, expEpochSeconds - Math.floor(Date.now() / 1000));
  }
}
