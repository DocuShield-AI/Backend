import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Enforces @Roles(...). Runs after JwtAuthGuard, so `req.user` is already
 * populated for anything that reached it.
 *
 * A route with no @Roles is open to any authenticated user — the decorator
 * narrows access, it never grants it, so forgetting it cannot accidentally
 * expose a route to the public.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) {
      return true;
    }

    const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>()
      .user;
    if (!user || !required.includes(user.role)) {
      // 403, not 401: the caller is known, they are simply not allowed.
      throw new ForbiddenException(
        `This action requires one of: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
