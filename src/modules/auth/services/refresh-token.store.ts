import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';

/**
 * Server-side record of which refresh tokens are still live.
 *
 * A refresh JWT is only half the story: its signature proves it was issued, not
 * that it is still allowed. Holding the set of valid token ids per user is what
 * turns "rotation" from cosmetic (a new token each time, old one still works)
 * into real (old one dies the moment it is used).
 *
 * Two sets are kept per user, because "not live" has two very different causes:
 *
 *   live  — usable right now.
 *   spent — retired by a rotation. A client that follows the protocol has
 *           already thrown this away, so seeing it again means a copy exists.
 *
 * A token that is in neither set (logged out, expired, never issued) is simply
 * rejected. Without that distinction a single stale browser tab replaying an
 * old token after logout would look identical to theft and would sign the user
 * out of every device.
 *
 * Redis rather than a Postgres column, because that would mean a migration on
 * the shared schema, and because these records are inherently short-lived —
 * they expire on their own with the token's TTL.
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
      // Pushed forward on every issue, so the set outlives its newest member.
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

  /**
   * Drops every session for a user. Used when a spent token is replayed: the
   * legitimate client no longer holds it, so its reappearance means a copy
   * leaked, and the safe response is to end every session rather than guess
   * which one is the attacker.
   */
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
