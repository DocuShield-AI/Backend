import { IsIn } from 'class-validator';
import { Role } from '@prisma/client';

/** The new role an admin assigns to a member of their workspace. */
export class UpdateRoleDto {
  @IsIn([Role.admin, Role.legal, Role.viewer])
  role: Role;
}