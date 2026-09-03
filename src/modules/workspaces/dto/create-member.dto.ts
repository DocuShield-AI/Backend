import { Role } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * An admin provisioning a teammate into their own workspace. The workspace is
 * never part of the body — it comes from the admin's token.
 */
export class CreateMemberDto {
  @IsEmail()
  email: string;

  /** bcrypt truncates past 72 bytes, so the cap is enforced rather than silent. */
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  /**
   * The whole point of this endpoint: until it existed, every account in the
   * system was an admin of its own workspace and legal/viewer were unreachable.
   */
  @IsEnum(Role)
  role: Role;
}
