import { IsString, IsNotEmpty } from 'class-validator';

export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  workspaceId: string;

  @IsString()
  @IsNotEmpty()
  plan: 'pro' | 'enterprise';
}
