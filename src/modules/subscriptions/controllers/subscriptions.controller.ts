import { Body, Controller, Post } from '@nestjs/common';
import { StripeService } from '../services/stripe.service';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('checkout')
  async createCheckout(
    @Body() dto: CreateCheckoutDto,
  ): Promise<{ url: string; sessionId: string }> {
    return this.stripeService.createCheckoutSession(dto);
  }
}
