import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';

/**
 * Flags a user so JwtStrategy ignores the role baked into their access token
 * and re-reads it from the DB. Without this, a role change stays hidden until
 * the token expires (~15m). Fail-open: an unreachable Redis must not take the
 * API down; a stale role for a few minutes is the acceptable price.
 */
@Injectable()
export class RoleInvalidationStore {
  private readonly logger = new Logger(RoleInvalidationStore.name);

  constructor(private readonly cache: RedisCacheService) {}

  private key(userId: string): string {
    return `auth:role-invalidated:${userId}`;
  }

  async invalidate(userId: string, ttlSeconds: number): Promise<void> {
    const client = this.cache.Client;
    if (!client) {
      this.logger.warn('Redis unavailable; role change will lag until token expiry');
      return;
    }
    try {
      await client.set(this.key(userId), '1', 'EX', ttlSeconds);
    } catch (err) {
      this.logger.error(`Failed to invalidate role for user ${userId}: ${this.message(err)}`);
    }
  }

  async isInvalidated(userId: string): Promise<boolean> {
    const client = this.cache.Client;
    if (!client) {
      return false;
    }
    try {
      return (await client.exists(this.key(userId))) === 1;
    } catch (err) {
      this.logger.error(`Role-invalidation check failed for user ${userId}: ${this.message(err)}`);
      return false;
    }
  }

  async clear(userId: string): Promise<void> {
    const client = this.cache.Client;
    if (!client) {
      return;
    }
    try {
      await client.del(this.key(userId));
    } catch (err) {
      this.logger.error(`Failed to clear role invalidation for user ${userId}: ${this.message(err)}`);
    }
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}