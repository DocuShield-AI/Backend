import { Role } from '@prisma/client';

/**
 * httpOnly cookie names. The access token rides in one, the refresh token in
 * the other. Keeping both away from JavaScript (no localStorage) means a
 * script-injection bug cannot walk off with a session.
 */
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Claims carried inside both token types. `sub` is the user id (JWT standard);
 * workspaceId and role travel in the token so guards never need a DB round-trip
 * on the hot path — see JwtStrategy for the staleness trade-off this implies.
 */
export interface JwtPayload {
  sub: string;
  workspaceId: string;
  role: Role;
  email: string;
}

/**
 * Shape attached to `req.user` on every authenticated request. The
 * @CurrentUser() decorator (Phase 3) reads from this, which is what finally
 * removes the hardcoded 'workspace-placeholder' from the contracts controller.
 * email lets a protected route (e.g. `/auth/me`) tell the frontend who is
 * signed in without the client ever seeing the raw token.
 */
export interface AuthenticatedUser {
  userId: string;
  workspaceId: string;
  role: Role;
  email: string;
}

/**
 * Refresh tokens additionally carry a unique id. That id is what the
 * RefreshTokenStore records, so a single refresh token can be revoked without
 * invalidating the user's other sessions.
 */
export interface RefreshTokenPayload extends JwtPayload {
  jti: string;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * What an OAuth provider tells us about the person signing in, reduced to the
 * only fields the account logic needs.
 */
export interface OAuthProfile {
  email: string;
  provider: string;
  displayName?: string;
}
