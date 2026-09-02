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
    // The workspace is taken from the token, never from the body — otherwise
    // any authenticated user could start a checkout against someone else's
    // workspace. The DTO still declares the field; it is simply overridden.
    return this.stripeService.createCheckoutSession({ ...dto, workspaceId });
  }
}
