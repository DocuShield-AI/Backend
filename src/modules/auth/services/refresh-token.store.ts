import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';

/**
 * Server-side record of which refresh tokens are still live. Two sets per user,
 * because "not live" has two very different causes: `live` is usable right now;
 * `spent` was retired by a rotation — seeing it again means a copy leaked.
 * A token in neither set (logged out, expired) is just rejected, so a stale tab
 * cannot look like theft and nuke every device.
 */
@Injectable()
export class RefreshTokenStore {
  private readonly logger = new Logger(RefreshTokenStore.name);

  constructor(private readonly cache: RedisCacheService) {}

  private liveKey(userId: string): string {
    return `auth:refresh:${userId}`;
  }

  private spentKey(userId: string): string {
    return `auth:refresh:spent:${userId}`;
  }

  /** Records a newly issued refresh token as usable. */
  async remember(userId: string, jti: string, ttlSeconds: number): Promise<void> {
    await this.run(async (client) => {
      await client.sadd(this.liveKey(userId), jti);
      // Redis TTL is pushed forward on every issue so the set outlives its newest member.
      await client.expire(this.liveKey(userId), ttlSeconds);
    });
  }

  async isValid(userId: string, jti: string): Promise<boolean> {
    return this.run(
      async (client) => (await client.sismember(this.liveKey(userId), jti)) === 1,
    );
  }

  /** Rotation: the token is consumed, and remembered as consumed. */
  async retire(userId: string, jti: string, ttlSeconds: number): Promise<void> {
    await this.run(async (client) => {
      await client.srem(this.liveKey(userId), jti);
      await client.sadd(this.spentKey(userId), jti);
      await client.expire(this.spentKey(userId), ttlSeconds);
    });
  }

  /** Logout: the token is dropped without being marked as replayed-if-seen. */
  async forget(userId: string, jti: string): Promise<void> {
    await this.run(async (client) => {
      await client.srem(this.liveKey(userId), jti);
    });
  }

  async wasSpent(userId: string, jti: string): Promise<boolean> {
    return this.run(
      async (client) => (await client.sismember(this.spentKey(userId), jti)) === 1,
    );
  }

  // Replaying a spent token means a copy leaked; end every session rather than
  // guess which one belongs to the attacker.
  async revokeAll(userId: string): Promise<void> {
    await this.run(async (client) => {
      await client.del(this.liveKey(userId));
      await client.del(this.spentKey(userId));
    });
  }

  /**
   * Fails closed. If the store cannot be reached we cannot prove a token is
   * still valid, and treating "unknown" as "allowed" would quietly disable
   * revocation for exactly as long as the outage lasts.
   */
  private async run<T>(fn: (client: Redis) => Promise<T>): Promise<T> {
    const client = this.cache.Client;
    if (!client) {
      throw new ServiceUnavailableException('Session store unavailable');
    }
    try {
      return await fn(client);
    } catch (err) {
      this.logger.error(
        `Refresh-token store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Session store unavailable');
    }
  }
}
