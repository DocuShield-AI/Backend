import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email: string;

  /**
   * bcrypt silently truncates anything past 72 bytes, so the cap is enforced
   * here rather than letting two different long passwords hash identically.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  /**
   * Signup creates the workspace as well as the user — the first account in a
   * workspace becomes its admin, which is what gives RBAC something to check.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workspaceName: string;
}
