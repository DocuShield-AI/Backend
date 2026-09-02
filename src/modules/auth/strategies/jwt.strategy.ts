import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser, JwtPayload } from '../auth.types';

/**
 * Verifies the Bearer access token and shapes `req.user`.
 *
 * The claims are trusted as-is instead of re-reading the user on every request:
 * a DB round-trip per call would put the whole API on the Postgres pool that
 * Part 4.4 is specifically trying to protect. The cost is that a role change
 * takes effect only after the current access token expires — bounded by
 * JWT_EXPIRES_IN (15m). Refresh does re-read the user, so the window cannot
 * extend past that.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    return {
      userId: payload.sub,
      workspaceId: payload.workspaceId,
      role: payload.role,
    };
  }
}
