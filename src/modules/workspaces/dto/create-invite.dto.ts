import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateInviteDto {
  /**
   * The role the invited person is given on join. Defaults to viewer when
   * omitted, keeping the least-privilege default.
   */
  @IsOptional()
  @IsIn([Role.admin, Role.legal, Role.viewer])
  role?: Role;

  /** How long the invite stays valid. Defaults to 7 days. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}