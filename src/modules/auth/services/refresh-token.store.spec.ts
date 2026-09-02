import { ServiceUnavailableException } from '@nestjs/common';

// Both reach this spec only through RedisCacheService, which the store names as
// a constructor type. Neither is exercised here — the fake client below stands
// in for the connection entirely.
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: class Redis {},
}));

import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import { RefreshTokenStore } from './refresh-token.store';

const makeFakeRedis = () => {
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  return {
    sets,
    ttls,
    client: {
      sadd: (key: string, member: string) => {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key)!.add(member);
        return Promise.resolve(1);
      },
      sismember: (key: string, member: string) =>
        Promise.resolve(sets.get(key)?.has(member) ? 1 : 0),
      srem: (key: string, member: string) => {
        sets.get(key)?.delete(member);
        return Promise.resolve(1);
      },
      del: (key: string) => {
        sets.delete(key);
        return Promise.resolve(1);
      },
      expire: (key: string, seconds: number) => {
        ttls.set(key, seconds);
        return Promise.resolve(1);
      },
    },
  };
};

const storeOver = (client: unknown) =>
  new RefreshTokenStore({ Client: client } as unknown as RedisCacheService);

describe('RefreshTokenStore', () => {
  let redis: ReturnType<typeof makeFakeRedis>;
  let store: RefreshTokenStore;

  beforeEach(() => {
    redis = makeFakeRedis();
    store = storeOver(redis.client);
  });

  it('remembers an issued token and gives it a TTL', async () => {
    await store.remember('u_1', 'jti_1', 604800);

    await expect(store.isValid('u_1', 'jti_1')).resolves.toBe(true);
    expect(redis.ttls.get('auth:refresh:u_1')).toBe(604800);
  });

  it('keeps users apart: a token of one user is not valid for another', async () => {
    await store.remember('u_1', 'jti_1', 60);

    await expect(store.isValid('u_2', 'jti_1')).resolves.toBe(false);
  });

  describe('retire vs forget — the distinction the whole design rests on', () => {
    it('retire moves a token to spent, so a replay is recognisable', async () => {
      await store.remember('u_1', 'jti_1', 60);
      await store.retire('u_1', 'jti_1', 60);

      await expect(store.isValid('u_1', 'jti_1')).resolves.toBe(false);
      await expect(store.wasSpent('u_1', 'jti_1')).resolves.toBe(true);
    });

    it('forget drops a token without marking it spent, so logout is not a leak', async () => {
      await store.remember('u_1', 'jti_1', 60);
      await store.forget('u_1', 'jti_1');

      await expect(store.isValid('u_1', 'jti_1')).resolves.toBe(false);
      // This is what stops a stale tab after logout from signing every device out.
      await expect(store.wasSpent('u_1', 'jti_1')).resolves.toBe(false);
    });
  });

  it('revokeAll clears live and spent together', async () => {
    await store.remember('u_1', 'jti_live', 60);
    await store.remember('u_1', 'jti_old', 60);
    await store.retire('u_1', 'jti_old', 60);

    await store.revokeAll('u_1');

    await expect(store.isValid('u_1', 'jti_live')).resolves.toBe(false);
    await expect(store.wasSpent('u_1', 'jti_old')).resolves.toBe(false);
  });

  describe('fails closed', () => {
    it('refuses to answer when there is no client at all', async () => {
      const orphan = storeOver(undefined);

      await expect(orphan.isValid('u_1', 'jti_1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('refuses to answer when Redis errors, rather than assuming "valid"', async () => {
      const broken = storeOver({
        sismember: () => Promise.reject(new Error('ECONNREFUSED')),
      });

      // The dangerous bug would be returning true here: revocation would be
      // silently switched off for the length of the outage.
      await expect(broken.isValid('u_1', 'jti_1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('refuses to issue a record it cannot store', async () => {
      const broken = storeOver({
        sadd: () => Promise.reject(new Error('ECONNREFUSED')),
      });

      // Handing out a token that was never recorded would produce a refresh
      // token that can never be redeemed.
      await expect(broken.remember('u_1', 'jti_1', 60)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
