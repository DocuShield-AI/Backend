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
import { randomInt, randomUUID } from 'crypto';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { PasswordResetStore } from './password-reset.store';
import { RefreshTokenStore } from './refresh-token.store';
import { SignupVerificationStore } from './signup-verification.store';
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

export const PASSWORD_RESET_SENT_MESSAGE =
  'If an account exists for this email, a reset code has been sent.';

export const SIGNUP_VERIFICATION_SENT_MESSAGE =
  'A verification code has been sent to your email.';

export const SIGNUP_CODE_RESENT_MESSAGE =
  'If a pending signup exists for this email, a new verification code has been sent.';

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
    private readonly passwordResets: PasswordResetStore,
    private readonly signupVerifications: SignupVerificationStore,
    private readonly email: EmailService,
  ) {}

  /**
   * Starts signup by emailing an 8-digit verification code. The account is
   * created only after the code is confirmed — see verifySignup().
   */
  async signup(
    dto: SignupDto,
  ): Promise<{ message: string; email: string; requiresVerification: true }> {
    const normalized = dto.email.toLowerCase();
    const type = dto.type ?? 'create';

    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    if (type === 'join') {
      await this.assertJoinInviteValid(dto.inviteCode);
    } else if (!dto.workspaceName) {
      throw new BadRequestException(
        'A workspace name is required to create a company',
      );
    }

    const code = String(randomInt(10_000_000, 99_999_999));
    const [codeHash, passwordHash] = await Promise.all([
      this.password.hash(code),
      this.password.hash(dto.password),
    ]);

    await this.signupVerifications.save(normalized, {
      codeHash,
      passwordHash,
      type,
      workspaceName: dto.workspaceName,
      inviteCode: dto.inviteCode?.trim().toUpperCase(),
    });

    await this.email.sendSignupVerificationCode(normalized, code);

    return {
      message: SIGNUP_VERIFICATION_SENT_MESSAGE,
      email: normalized,
      requiresVerification: true,
    };
  }

  /** Completes signup after the email verification code is confirmed. */
  async verifySignup(email: string, code: string): Promise<AuthResult> {
    const normalized = email.toLowerCase();
    const record = await this.assertValidSignupCode(normalized, code);
    await this.signupVerifications.delete(normalized);

    if (record.type === 'join') {
      return this.joinWorkspaceWithInvite({
        code: record.inviteCode,
        email: normalized,
        passwordHash: record.passwordHash,
      });
    }

    return this.createWorkspaceSignup({
      email: normalized,
      password: '',
      workspaceName: record.workspaceName,
      passwordHash: record.passwordHash,
    });
  }

  async resendSignupCode(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const pending = await this.signupVerifications.get(normalized);

    if (pending) {
      const code = String(randomInt(10_000_000, 99_999_999));
      const codeHash = await this.password.hash(code);
      await this.signupVerifications.save(normalized, {
        ...pending,
        codeHash,
      });
      await this.email.sendSignupVerificationCode(normalized, code);
    }

    return { message: SIGNUP_CODE_RESENT_MESSAGE };
  }

  private async createWorkspaceSignup(
    dto: SignupDto & { passwordHash?: string },
  ): Promise<AuthResult> {
    if (!dto.workspaceName) {
      throw new BadRequestException(
        'A workspace name is required to create a company',
      );
    }
    const workspaceName: string = dto.workspaceName;
    const passwordHash =
      dto.passwordHash ?? (await this.password.hash(dto.password));

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

  /**
   * Sends an 8-digit reset code. Always returns the same message so callers
   * cannot tell whether the email is registered.
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (user) {
      const code = String(randomInt(10_000_000, 99_999_999));
      const codeHash = await this.password.hash(code);
      await this.passwordResets.save(normalized, {
        userId: user.id,
        codeHash,
      });

      await this.email.sendPasswordResetCode(normalized, code);
    }

    return { message: PASSWORD_RESET_SENT_MESSAGE };
  }

  /** Checks a reset code without consuming it (matches frontend two-step UI). */
  async verifyResetCode(email: string, code: string): Promise<{ valid: true }> {
    await this.assertValidResetCode(email, code);
    return { valid: true };
  }

  /** Verifies the code, updates the password, and revokes all sessions. */
  async resetPassword(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const normalized = email.toLowerCase();
    const record = await this.assertValidResetCode(normalized, code);

    const passwordHash = await this.password.hash(newPassword);
    await this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    });

    await this.passwordResets.delete(normalized);
    await this.refreshTokens.revokeAll(record.userId);

    this.logger.log(`Password reset completed for user ${record.userId}`);
    return { message: 'Password updated successfully' };
  }

  private async assertJoinInviteValid(code?: string): Promise<void> {
    const normalized = code?.trim().toUpperCase();
    if (!normalized) {
      throw new BadRequestException('An invite code is required to join a company');
    }

    const invite = await this.prisma.invitation.findUnique({
      where: { code: normalized },
    });
    if (!invite) {
      throw new BadRequestException('Invalid invite code');
    }
    if (invite.expiresAt < new Date()) {
      throw new BadRequestException('Invite code has expired');
    }
    if (invite.usedAt) {
      throw new BadRequestException('Invite code has already been used');
    }
  }

  private async assertValidSignupCode(email: string, code: string) {
    const record = await this.signupVerifications.get(email);
    if (!record) {
      throw new BadRequestException('Invalid or expired code');
    }

    const ok = await this.password.compare(code, record.codeHash);
    if (!ok) {
      throw new BadRequestException('Invalid or expired code');
    }

    return record;
  }

  private async assertValidResetCode(email: string, code: string) {
    const normalized = email.toLowerCase();
    const record = await this.passwordResets.get(normalized);
    if (!record) {
      throw new BadRequestException('Invalid or expired code');
    }

    const ok = await this.password.compare(code, record.codeHash);
    if (!ok) {
      throw new BadRequestException('Invalid or expired code');
    }

    return record;
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
