import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StripeService } from './services/stripe.service';
import { StripeWebhookController } from './controllers/stripe-webhook.controller';
import { SubscriptionsController } from './controllers/subscriptions.controller';

@Module({
  imports: [ConfigModule],
  controllers: [SubscriptionsController, StripeWebhookController],
  providers: [StripeService],
  exports: [StripeService],
})
export class SubscriptionsModule {}
