import { IsEmail } from 'class-validator';

export class ResendSignupCodeDto {
  @IsEmail()
  email: string;
}
