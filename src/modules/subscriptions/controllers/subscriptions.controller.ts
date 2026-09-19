import { Body, Controller, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { StripeService } from '../services/stripe.service';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('checkout')
  @Roles(Role.admin)
  async createCheckout(
    @Body() dto: CreateCheckoutDto,
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<{ url: string; sessionId: string }> {
    return this.stripeService.createCheckoutSession({ ...dto, workspaceId });
  }
}