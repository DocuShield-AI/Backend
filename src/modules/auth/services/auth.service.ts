import {
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
  ) {}

  /**
   * Creates a workspace and its first user together, in one transaction. They
   * are inseparable: `User.workspaceId` is a non-null foreign key, so a user
   * without a workspace cannot exist, and a half-applied signup would leave an
   * orphan workspace behind.
   */
  async signup(dto: SignupDto): Promise<AuthResult> {
    const passwordHash = await this.password.hash(dto.password);

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: dto.workspaceName },
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
      // Relying on the unique index rather than a pre-check, so two concurrent
      // signups for the same email cannot both pass a lookup and then collide.
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

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Both branches return the same error on purpose — distinguishing "no such
    // email" from "wrong password" would let anyone enumerate registered users.
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
   * so each refresh token is usable exactly once.
   *
   * A token that was already rotated away and then reappears cannot have come
   * from a well-behaved client, so it is treated as a leaked copy and every
   * session for the user is dropped. A token that is merely unknown — logged
   * out, expired — is just rejected.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);

    if (!(await this.refreshTokens.isValid(payload.sub, payload.jti))) {
      // Only a token that was rotated away counts as a leak. One that is simply
      // unknown — logged out, expired — is a stale client, not an attacker.
      if (await this.refreshTokens.wasSpent(payload.sub, payload.jti)) {
        this.logger.warn(
          `Refresh-token replay detected for user ${payload.sub}; revoking all sessions`,
        );
        await this.refreshTokens.revokeAll(payload.sub);
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Re-read the user so a deleted account, or one whose role changed, cannot
    // keep refreshing on claims baked into an old token.
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
   *
   * Matching is by email, which is only safe because the strategy refuses an
   * unverified address — otherwise anyone able to register that address with
   * the provider could walk into an existing account.
   */
  async validateOAuthLogin(profile: OAuthProfile): Promise<AuthResult> {
    const email = profile.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      // First OAuth sign-in for an account that was created with a password:
      // record the provider, but leave the password working.
      const user = existing.oauthProvider
        ? existing
        : await this.prisma.user.update({
            where: { id: existing.id },
            data: { oauthProvider: profile.provider },
          });
      this.logger.log(`OAuth login: user ${user.id} via ${profile.provider}`);
      return this.buildResult(user);
    }

    // A brand new account gets the same shape as signup: a workspace and its
    // first admin. The stored hash is of a value nobody holds, so the password
    // route stays permanently closed for this account until a real reset.
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
   * Access and refresh tokens are signed with two different secrets, so a
   * leaked access token cannot be replayed against the refresh endpoint to mint
   * an endless supply of new ones.
   *
   * Only the refresh token is recorded server-side. The access token stays
   * deliberately stateless — checking a store on every API call would put the
   * whole app on Redis for its hot path; its 15-minute life is the bound.
   */
  private async issueTokens(user: User): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
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

    // The token's own `exp` decides how long the record lives, so the two can
    // never drift apart the way a separately-parsed TTL would.
    const decoded = this.jwt.decode(refreshToken) as RefreshTokenPayload | null;
    await this.refreshTokens.remember(
      user.id,
      jti,
      this.secondsUntil(decoded?.exp ?? 0),
    );

    return { accessToken, refreshToken };
  }

  /** Seconds left on a token, floored at 1 so Redis never gets a stale TTL. */
  private secondsUntil(expEpochSeconds: number): number {
    return Math.max(1, expEpochSeconds - Math.floor(Date.now() / 1000));
  }
}
