import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { JwtPayload } from '../auth.types';

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

  const strategy = new JwtStrategy(config);

  it('maps token claims onto the shape guards and @CurrentUser expect', () => {
    const payload: JwtPayload = {
      sub: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
    };

    expect(strategy.validate(payload)).toEqual({
      userId: 'u_1',
      workspaceId: 'ws_1',
      role: Role.legal,
    });
  });

  it('carries the role through unchanged, since RolesGuard compares it directly', () => {
    for (const role of [Role.admin, Role.legal, Role.viewer]) {
      expect(
        strategy.validate({ sub: 'u_1', workspaceId: 'ws_1', role }).role,
      ).toBe(role);
    }
  });

  it('refuses to start without a signing secret', () => {
    const missing = {
      getOrThrow: jest.fn(() => {
        throw new Error('JWT_SECRET is not set');
      }),
    } as unknown as ConfigService;

    expect(() => new JwtStrategy(missing)).toThrow('JWT_SECRET is not set');
  });
});
