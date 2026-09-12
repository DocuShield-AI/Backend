import { Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';

/**
 * Option-D role invalidation: a tiny Redis "chit" that tells JwtStrategy to
 * ignore the role baked into a token and re-read it from the database.
 *
 * Without this, a role change stays hidden until the access token expires
 * (default 15m), because the token carries its own claims. Writing the user's
 * id here the moment the DB row changes makes the new role effective on the
 * very next request, while everyone else keeps the fast no-DB path.
 *
 * Unlike RefreshTokenStore this is intentionally fail-open: an unreachable
 * Redis must not take the whole API down, and a stale role for a few minutes
 * is a minor cost. The role-change itself still writes the flag and the
 * failure is logged.
 */
@Injectable()
export class RoleInvalidationStore {
  private readonly logger = new Logger(RoleInvalidationStore.name);

  constructor(private readonly cache: RedisCacheService) {}

  private key(userId: string): string {
    return `auth:role-invalidated:${userId}`;
  }

  /** Flags a user so the next request ignores the role in their token. */
  async invalidate(userId: string, ttlSeconds: number): Promise<void> {
    const client = this.cache.Client;
    if (!client) {
      this.logger.warn('Redis unavailable; role change will lag until token expiry');
      return;
    }
    try {
      // The flag only needs to outlive the access token it is overriding, so it
      // expires on its own even if no refresh ever clears it.
      const multi = client.multi();
      multi.sadd(this.key(userId), '1');
      multi.expire(this.key(userId), ttlSeconds);
      await multi.exec();
    } catch (err) {
      this.logger.error(
        `Failed to store role invalidation for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** True when the token's role claim is stale and the DB must be consulted. */
  async isInvalidated(userId: string): Promise<boolean> {
    const client = this.cache.Client;
    if (!client) {
      return false;
    }
    try {
      return (await client.sismember(this.key(userId), '1')) === 1;
    } catch (err) {
      this.logger.error(
        `Role-invalidation check failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Fail open: this check must never block the hot path. Worst case a role
      // change waits out the remaining token TTL.
      return false;
    }
  }

  /** Clears the flag once a token with the fresh role has been issued. */
  async clear(userId: string): Promise<void> {
    const client = this.cache.Client;
    if (!client) {
      return;
    }
    try {
      await client.del(this.key(userId));
    } catch (err) {
      this.logger.error(
        `Failed to clear role invalidation for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}