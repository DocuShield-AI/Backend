import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenStore } from './refresh-token.store';
import { JwtPayload } from '../auth.types';

// @nestjs/config v12 ships ESM only, which Jest's CommonJS runtime cannot parse.
// Same workaround the Stripe spec already uses in this repo.
jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

// @nestjs/jwt is ESM only for the same reason, so it is stood up here over the
// CommonJS `jsonwebtoken` it wraps. The signing and verification below is the
// real library, not a stub — otherwise "the two secrets are independent" would
// only be asserting against a fake, which proves nothing.
jest.mock('@nestjs/jwt', () => {
  const lib = require('jsonwebtoken');
  return {
    JwtService: class JwtService {
      constructor(private readonly opts: any = {}) {}
      private secretFor(options?: any) {
        return options?.secret ?? this.opts.secret;
      }
      signAsync(payload: any, options?: any) {
        return Promise.resolve(
          lib.sign(payload, this.secretFor(options), {
            expiresIn:
              options?.expiresIn ?? this.opts.signOptions?.expiresIn ?? '15m',
          }),
        );
      }
      verifyAsync(token: string, options?: any) {
        return Promise.resolve(lib.verify(token, this.secretFor(options)));
      }
      verify(token: string, options?: any) {
        return lib.verify(token, this.secretFor(options));
      }
      decode(token: string) {
        return lib.decode(token);
      }
    },
  };
});

const ACCESS_SECRET = 'access-secret-for-tests';
const REFRESH_SECRET = 'refresh-secret-for-tests';

const makeUser = (over: Partial<User> = {}): User =>
  ({
    id: 'u_1',
    workspaceId: 'ws_1',
    email: 'legal@acme.com',
    passwordHash: '',
    role: Role.admin,
    oauthProvider: null,
    createdAt: new Date(),
    ...over,
  }) as User;

/**
 * In-memory stand-in for the handful of Redis set commands the store uses.
 * The store's own logic stays real — only the network is replaced.
 */
const makeFakeRedis = () => {
  const sets = new Map<string, Set<string>>();
  return {
    sets,
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
      expire: () => Promise.resolve(1),
    },
  };
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let password: PasswordService;
  let redis: ReturnType<typeof makeFakeRedis>;
  let store: RefreshTokenStore;

  const jwt = new JwtService({
    secret: ACCESS_SECRET,
    signOptions: { expiresIn: '15m' },
  });

  const config = {
    get: jest.fn(() => undefined),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'JWT_REFRESH_SECRET') return REFRESH_SECRET;
      throw new Error(`Unexpected key ${key}`);
    }),
  } as unknown as ConfigService;

  /** Signs a user in and returns the issued pair. */
  const loginAs = async (user: User = makeUser()) => {
    const passwordHash = await password.hash('a-good-password');
    prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash });
    return service.login({
      email: 'legal@acme.com',
      password: 'a-good-password',
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // 4 rounds keeps the suite fast; production reads 12 from BCRYPT_SALT_ROUNDS.
    password = new PasswordService({ get: () => '4' } as unknown as ConfigService);
    redis = makeFakeRedis();
    store = new RefreshTokenStore({
      Client: redis.client,
    } as unknown as RedisCacheService);
    prisma = {
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new AuthService(
      prisma as PrismaService,
      password,
      jwt,
      config,
      store,
    );
  });

  describe('signup', () => {
    it('creates the workspace and its first user as an admin, in one transaction', async () => {
      const workspaceCreate = jest.fn().mockResolvedValue({ id: 'ws_1' });
      const userCreate = jest.fn().mockResolvedValue(makeUser());
      prisma.$transaction.mockImplementation((cb: any) =>
        cb({ workspace: { create: workspaceCreate }, user: { create: userCreate } }),
      );

      const result = await service.signup({
        email: 'Legal@Acme.com',
        password: 'a-good-password',
        workspaceName: 'Acme Legal',
      });

      expect(workspaceCreate).toHaveBeenCalledWith({ data: { name: 'Acme Legal' } });
      expect(userCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws_1',
            // Email is normalised, so Legal@Acme.com and legal@acme.com are one account.
            email: 'legal@acme.com',
            role: Role.admin,
          }),
        }),
      );

      // The password must never be stored in the clear.
      const stored = userCreate.mock.calls[0][0].data.passwordHash;
      expect(stored).not.toBe('a-good-password');
      await expect(password.compare('a-good-password', stored)).resolves.toBe(true);

      expect(result.user).toEqual({
        id: 'u_1',
        email: 'legal@acme.com',
        role: Role.admin,
        workspaceId: 'ws_1',
      });
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it('turns a duplicate-email unique violation into a 409, not a 500', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.signup({
          email: 'taken@acme.com',
          password: 'a-good-password',
          workspaceName: 'Acme',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('issues tokens carrying userId, workspaceId and role', async () => {
      const result = await loginAs(makeUser({ role: Role.legal }));

      const claims = jwt.verify<JwtPayload>(result.accessToken, {
        secret: ACCESS_SECRET,
      });
      expect(claims.sub).toBe('u_1');
      expect(claims.workspaceId).toBe('ws_1');
      expect(claims.role).toBe(Role.legal);
    });

    it('rejects a wrong password', async () => {
      const passwordHash = await password.hash('a-good-password');
      prisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));

      await expect(
        service.login({ email: 'legal@acme.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('gives an unknown email the identical error to a wrong password (no user enumeration)', async () => {
      const passwordHash = await password.hash('a-good-password');

      prisma.user.findUnique.mockResolvedValue(null);
      const unknownEmail = await service
        .login({ email: 'nobody@acme.com', password: 'x' })
        .catch((e: Error) => e.message);

      prisma.user.findUnique.mockResolvedValue(makeUser({ passwordHash }));
      const wrongPassword = await service
        .login({ email: 'legal@acme.com', password: 'x' })
        .catch((e: Error) => e.message);

      expect(unknownEmail).toBe(wrongPassword);
    });
  });

  describe('refresh', () => {
    it('exchanges a valid refresh token for a new pair', async () => {
      const { refreshToken } = await loginAs();

      const pair = await service.refresh(refreshToken);

      expect(
        jwt.verify<JwtPayload>(pair.accessToken, { secret: ACCESS_SECRET }).sub,
      ).toBe('u_1');
      expect(pair.refreshToken).not.toBe(refreshToken);
    });

    it('retires the old refresh token — rotation is real, not cosmetic', async () => {
      const { refreshToken: first } = await loginAs();
      const { refreshToken: second } = await service.refresh(first);

      // The replacement works...
      await expect(service.refresh(second)).resolves.toBeDefined();
      // ...and the one it replaced is dead, even though its signature is fine.
      await expect(service.refresh(first)).rejects.toThrow(UnauthorizedException);
    });

    it('treats replay of a spent token as a leak and drops every session', async () => {
      // Two independent sessions, as if from two devices.
      const { refreshToken: deviceA } = await loginAs();
      const { refreshToken: deviceB } = await loginAs();

      const { refreshToken: deviceARotated } = await service.refresh(deviceA);

      // The spent token reappears — only a copy could send this.
      await expect(service.refresh(deviceA)).rejects.toThrow(UnauthorizedException);

      // Everything for that user is now revoked, including the untouched device.
      await expect(service.refresh(deviceARotated)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refresh(deviceB)).rejects.toThrow(UnauthorizedException);
    });

    it('refuses an ACCESS token at the refresh endpoint — the two secrets are independent', async () => {
      const { accessToken } = await loginAs();

      // This is the whole reason for two secrets: a stolen access token must
      // not be replayable into an endless supply of fresh tokens.
      await expect(service.refresh(accessToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses an expired refresh token even though it is still in the store', async () => {
      const expired = await jwt.signAsync(
        { sub: 'u_1', workspaceId: 'ws_1', role: Role.admin, jti: 'jti_old' },
        { secret: REFRESH_SECRET, expiresIn: '-1s' },
      );
      // Recorded as live, so only the signature check can catch this.
      await store.remember('u_1', 'jti_old', 60);
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.refresh(expired)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a refresh token that carries no session id', async () => {
      // A token minted before jti existed, or hand-crafted to skip the store.
      const noJti = await jwt.signAsync(
        { sub: 'u_1', workspaceId: 'ws_1', role: Role.admin },
        { secret: REFRESH_SECRET, expiresIn: '7d' },
      );

      await expect(service.refresh(noJti)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses to refresh for a user that no longer exists', async () => {
      const { refreshToken } = await loginAs();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.refresh(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('validateOAuthLogin', () => {
    const googleProfile = {
      email: 'New@Acme.com',
      provider: 'google',
      displayName: 'New User',
    };

    it('creates a workspace and an admin on first sign-in', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const workspaceCreate = jest.fn().mockResolvedValue({ id: 'ws_new' });
      const userCreate = jest
        .fn()
        .mockResolvedValue(makeUser({ id: 'u_new', workspaceId: 'ws_new' }));
      prisma.$transaction.mockImplementation((cb: any) =>
        cb({ workspace: { create: workspaceCreate }, user: { create: userCreate } }),
      );

      const result = await service.validateOAuthLogin(googleProfile);

      expect(workspaceCreate).toHaveBeenCalledWith({
        data: { name: "New User's workspace" },
      });
      expect(userCreate.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          email: 'new@acme.com',
          role: Role.admin,
          oauthProvider: 'google',
        }),
      );
      expect(result.accessToken).toEqual(expect.any(String));
    });

    it('stores a password nobody can use, so the password route stays shut', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const userCreate = jest.fn().mockResolvedValue(makeUser());
      prisma.$transaction.mockImplementation((cb: any) =>
        cb({
          workspace: { create: jest.fn().mockResolvedValue({ id: 'ws_new' }) },
          user: { create: userCreate },
        }),
      );

      await service.validateOAuthLogin(googleProfile);

      const hash = userCreate.mock.calls[0][0].data.passwordHash;
      expect(hash.startsWith('$2')).toBe(true);
      // Nothing predictable unlocks it.
      await expect(password.compare('', hash)).resolves.toBe(false);
      await expect(password.compare('google', hash)).resolves.toBe(false);
      await expect(password.compare(googleProfile.email, hash)).resolves.toBe(false);
    });

    it('links the provider to an existing password account instead of duplicating it', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ oauthProvider: null }));
      prisma.user.update = jest
        .fn()
        .mockResolvedValue(makeUser({ oauthProvider: 'google' }));

      await service.validateOAuthLogin({ ...googleProfile, email: 'legal@acme.com' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u_1' },
        data: { oauthProvider: 'google' },
      });
      // No second workspace for someone who already has one.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not rewrite the provider on a returning OAuth user', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser({ oauthProvider: 'google' }));
      prisma.user.update = jest.fn();

      await service.validateOAuthLogin({ ...googleProfile, email: 'legal@acme.com' });

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('ends the session it was given and leaves other devices signed in', async () => {
      const { refreshToken: deviceA } = await loginAs();
      const { refreshToken: deviceB } = await loginAs();

      await service.logout(deviceA);

      await expect(service.refresh(deviceA)).rejects.toThrow(UnauthorizedException);
      await expect(service.refresh(deviceB)).resolves.toBeDefined();
    });
  });
});
