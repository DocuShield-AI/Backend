import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { ACCESS_TOKEN_COOKIE, JwtPayload } from '../auth.types';
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

import { JwtStrategy, fromCookieOrBearer } from './jwt.strategy';

const payloadWith = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'u_1',
  workspaceId: 'ws_1',
  role: Role.legal,
  email: 'legal@acme.com',
  ...over,
});

const userWith = (over: Partial<Record<'id' | 'workspaceId' | 'role' | 'email', unknown>> = {}) => ({
  id: 'u_1',
  workspaceId: 'ws_1',
  role: Role.legal,
  email: 'legal@acme.com',
  ...over,
});

describe('fromCookieOrBearer', () => {
  const reqWith = (over: object) => ({ headers: {}, cookies: {}, ...over });

  it('prefers the Authorization header when both are present', () => {
    const req = reqWith({
      headers: { authorization: 'Bearer header-token' },
      cookies: { [ACCESS_TOKEN_COOKIE]: 'cookie-token' },
    }) as unknown as Request;

    expect(fromCookieOrBearer(req)).toBe('header-token');
  });

  it('falls back to the access-token cookie', () => {
    const req = reqWith({
      cookies: { [ACCESS_TOKEN_COOKIE]: 'cookie-token' },
    }) as unknown as Request;

    expect(fromCookieOrBearer(req)).toBe('cookie-token');
  });

  it('returns null when neither carries a token', () => {
    const req = reqWith({}) as unknown as Request;
    expect(fromCookieOrBearer(req)).toBeNull();
  });
});

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

    await expect(strategy.validate(payloadWith())).resolves.toEqual({
      userId: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
      email: 'legal@acme.com',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the fast path when nothing is flagged', async () => {
    roles.isInvalidated = jest.fn(async () => false);

    for (const role of [Role.admin, Role.legal, Role.viewer]) {
      const out = await strategy.validate(payloadWith({ role }));
      expect(out.role).toBe(role);
      expect(out.email).toBe('legal@acme.com');
    }
  });

  it('re-reads the fresh role and email from the DB for a flagged user', async () => {
    roles.isInvalidated = jest.fn(async () => true);
    prisma.user.findUnique = jest.fn().mockResolvedValue(
      userWith({ id: 'u_1', role: Role.legal, email: 'renamed@acme.com' }),
    );

    const out = await strategy.validate(
      payloadWith({ role: Role.admin, email: 'old@acme.com' }),
    );

    expect(out).toEqual({
      userId: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
      email: 'renamed@acme.com',
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u_1' },
      select: expect.anything(),
    });
  });

  it('treats a flagged user whose account is gone as unauthorized', async () => {
    roles.isInvalidated = jest.fn(async () => true);
    prisma.user.findUnique = jest.fn().mockResolvedValue(null);

    await expect(
      strategy.validate(payloadWith({ sub: 'u_ghost' })),
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