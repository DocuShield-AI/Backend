import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

const contextFor = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const userWith = (role: Role): AuthenticatedUser => ({
  userId: 'u_1',
  workspaceId: 'ws_1',
  role,
});

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  const requireRoles = (roles: Role[] | undefined) => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  };

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('lets an allowed role through', () => {
    requireRoles([Role.admin, Role.legal]);
    expect(guard.canActivate(contextFor(userWith(Role.legal)))).toBe(true);
  });

  it('blocks a role that is not listed', () => {
    requireRoles([Role.admin, Role.legal]);
    expect(() => guard.canActivate(contextFor(userWith(Role.viewer)))).toThrow(
      ForbiddenException,
    );
  });

  it('allows any authenticated user when a route declares no roles', () => {
    // @Roles narrows access; its absence must not silently grant or deny.
    requireRoles(undefined);
    expect(guard.canActivate(contextFor(userWith(Role.viewer)))).toBe(true);
  });

  it('blocks when the request carries no user at all', () => {
    requireRoles([Role.admin]);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('reads metadata from the handler first, then the controller', () => {
    const spy = jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([Role.admin]);

    guard.canActivate(contextFor(userWith(Role.admin)));

    expect(spy).toHaveBeenCalledWith(ROLES_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
