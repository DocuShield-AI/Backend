import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { JwtPayload } from '../auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleInvalidationStore } from '../services/role-invalidation.store';

jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

// @nestjs/passport is ESM only. The base class contributes nothing this spec
// cares about — validate() is the strategy's entire decision.
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class {
      constructor(..._args: unknown[]) {}
    },
}));

import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const config = {
    getOrThrow: jest.fn(() => 'a-secret'),
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;

  const prisma = {
    user: { findUnique: jest.fn() },
  } as unknown as PrismaService;

  const roles = {
    isInvalidated: jest.fn(),
  } as unknown as RoleInvalidationStore;

  const strategy = new JwtStrategy(config, prisma, roles);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('maps token claims onto the shape guards and @CurrentUser expect', async () => {
    roles.isInvalidated = jest.fn(async () => false);
    const payload: JwtPayload = {
      sub: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
    };

    await expect(strategy.validate(payload)).resolves.toEqual({
      userId: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the fast path when nothing is flagged', async () => {
    roles.isInvalidated = jest.fn(async () => false);

    for (const role of [Role.admin, Role.legal, Role.viewer]) {
      const out = await strategy.validate({ sub: 'u_1', workspaceId: 'ws_1', role });
      expect(out.role).toBe(role);
    }
  });

  it('re-reads the fresh role from the DB for a flagged user', async () => {
    roles.isInvalidated = jest.fn(async () => true);
    prisma.user.findUnique = jest.fn().mockResolvedValue({
      id: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
    });

    const out = await strategy.validate({
      sub: 'u_1',
      workspaceId: 'ws_1',
      role: Role.admin,
    });

    expect(out).toEqual({ userId: 'u_1', workspaceId: 'ws_1', role: Role.legal });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u_1' }, select: expect.anything() });
  });

  it('treats a flagged user whose account is gone as unauthorized', async () => {
    roles.isInvalidated = jest.fn(async () => true);
    prisma.user.findUnique = jest.fn().mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: 'u_ghost', workspaceId: 'ws_1', role: Role.admin }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses to start without a signing secret', () => {
    const missing = {
      getOrThrow: jest.fn(() => {
        throw new Error('JWT_SECRET is not set');
      }),
    } as unknown as ConfigService;

    expect(() => new JwtStrategy(missing, prisma, roles)).toThrow(
      'JWT_SECRET is not set',
    );
  });
});