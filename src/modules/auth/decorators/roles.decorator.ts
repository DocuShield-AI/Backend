import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'auth:roles';

/**
 * Restricts a route to the listed roles — the declarative role check that
 * replaces hand-written `if (user.role !== ...)` in every handler.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
