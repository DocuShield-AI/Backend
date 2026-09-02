import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

// @nestjs/passport is ESM only, like @nestjs/config and @nestjs/jwt in this
// repo's other specs. The base guard is stood up as something that returns a
// recognisable sentinel, so "did we bypass passport or delegate to it?" — the
// only thing this guard decides — is directly observable.
const PASSPORT_RAN = 'passport-ran';
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () =>
    class {
      canActivate() {
        return PASSPORT_RAN;
      }
    },
}));

// Imported after the mock so the guard extends the stand-in.
import { JwtAuthGuard } from './jwt-auth.guard';

const context = {
  getHandler: () => () => undefined,
  getClass: () => class {},
} as unknown as ExecutionContext;

describe('JwtAuthGuard', () => {
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtAuthGuard(reflector);
  });

  it('lets a @Public() route through without running passport', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('delegates to passport when the route is not public', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(context)).toBe(PASSPORT_RAN);
  });

  it('protects a route that simply forgot to say anything', () => {
    // The default direction matters: no metadata must mean "authenticate",
    // never "let it through".
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    expect(guard.canActivate(context)).toBe(PASSPORT_RAN);
  });

  it('looks the flag up on the handler and the controller', () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    guard.canActivate(context);

    expect(spy).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
