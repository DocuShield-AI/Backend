import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { IS_PUBLIC_KEY, Public } from './public.decorator';
import { ROLES_KEY, Roles } from './roles.decorator';

/**
 * The guards read these two keys; if a decorator ever wrote to a different key
 * the guard would silently stop seeing it, so the contract is pinned here.
 */
@Public()
@Controller('sample')
class PublicController {
  @Get('open')
  open(): void {}

  @Roles(Role.admin, Role.legal)
  @Get('restricted')
  restricted(): void {}
}

describe('auth decorators', () => {
  const reflector = new Reflector();

  it('@Public marks the class it is applied to', () => {
    expect(reflector.get(IS_PUBLIC_KEY, PublicController)).toBe(true);
  });

  it('@Roles records exactly the roles it was given, on the handler', () => {
    expect(
      reflector.get(ROLES_KEY, PublicController.prototype.restricted),
    ).toEqual([Role.admin, Role.legal]);
  });

  it('leaves an unannotated handler with no roles, so it is not narrowed', () => {
    expect(
      reflector.get(ROLES_KEY, PublicController.prototype.open),
    ).toBeUndefined();
  });
});
