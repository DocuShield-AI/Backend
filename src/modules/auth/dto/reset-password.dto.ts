import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Matches(/^\d{8}$/, { message: 'Code must be exactly 8 digits' })
  code: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
