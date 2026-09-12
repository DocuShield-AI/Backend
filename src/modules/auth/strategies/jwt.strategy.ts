import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleInvalidationStore } from '../services/role-invalidation.store';
import { AuthenticatedUser, JwtPayload } from '../auth.types';

/**
 * Verifies the Bearer access token and shapes `req.user`.
 *
 * The happy path trusts the claims as-is instead of re-reading the user on
 * every request — that keeps the hot path off the Postgres pool. The blind
 * spot of trusting a token's claims is that a role change stays hidden until
 * the token expires (15m). The RoleInvalidationStore closes that window: the
 * moment a role changes, the user is flagged in Redis and every following
 * request drops back to a single, tiny DB read to fetch the fresh role. Only
 * flagged users pay that read; everyone else keeps the fast path.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly roles: RoleInvalidationStore,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!(await this.roles.isInvalidated(payload.sub))) {
      return {
        userId: payload.sub,
        workspaceId: payload.workspaceId,
        role: payload.role,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, workspaceId: true, role: true },
    });
    if (!user) {
      // Token is signed correctly but the account is gone — treat it like a
      // revoked token, not a crash.
      throw new UnauthorizedException('Account no longer exists');
    }
    return {
      userId: user.id,
      workspaceId: user.workspaceId,
      role: user.role,
    };
  }
}
