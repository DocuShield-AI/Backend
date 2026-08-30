import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { StripeService } from '../services/stripe.service';

@Controller('subscriptions/webhook')
export class StripeWebhookController {
  constructor(private readonly stripeService: StripeService) {}

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException('Missing raw body');
    }

    let event;
    try {
      event = await this.stripeService.verifyWebhookSignature(raw, signature);
    } catch {
      // Reject unsigned / tampered requests consistently.
      throw new BadRequestException('Invalid webhook signature');
    }

    await this.stripeService.handleEvent(event);
    return { received: true };
  }
}
