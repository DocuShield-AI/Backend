import { IsIn, IsString } from 'class-validator';

export class CreateCheckoutDto {
  @IsString()
  @IsIn(['pro', 'enterprise'])
  plan: 'pro' | 'enterprise';
}