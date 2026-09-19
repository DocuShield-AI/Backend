import { IsEmail, IsString, Matches } from 'class-validator';

export class VerifySignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @Matches(/^\d{8}$/, { message: 'Code must be exactly 8 digits' })
  code: string;
}
