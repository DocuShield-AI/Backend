import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { N8nWebhookClient } from '../../notifications/n8n-webhook.client';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly n8n: N8nWebhookClient,
  ) {
    const key = this.config.getOrThrow<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    this.stripe = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });
  }

  private priceIdForPlan(plan: CreateCheckoutDto['plan']): string {
    const key = `STRIPE_PRICE_${plan.toUpperCase()}`;
    return this.config.getOrThrow<string>(key);
  }

  async createCheckoutSession(dto: CreateCheckoutDto): Promise<CheckoutResult> {
    const baseUrl = this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:4000';

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: undefined,
      line_items: [
        {
          price: this.priceIdForPlan(dto.plan),
          quantity: 1,
        },
      ],
      metadata: {
        workspaceId: dto.workspaceId,
        plan: dto.plan,
      },
      success_url: `${baseUrl}/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/subscriptions/cancel`,
    });

    return { url: session.url as string, sessionId: session.id };
  }

  /**
   * Verifies the raw Stripe webhook payload against the signature header.
   * Throws (and lets Nest return a 400) when the signature is invalid or
   * the payload has been tampered with.
   */
  async verifyWebhookSignature(
    payload: Buffer | string,
    signature: string | undefined,
  ): Promise<Stripe.Event> {
    if (!signature) {
      throw new Error('Missing Stripe signature header');
    }
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  /**
   * Handles a verified event. The payment-success event is the trigger Annas's
   * n8n automation listens for — its payload shape is documented in
   * docs/webhooks.md.
   */
  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await this.onSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        // Ignored event types are a no-op.
        break;
    }
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const workspaceId = session.metadata?.workspaceId;
    const plan = session.metadata?.plan as 'pro' | 'enterprise' | undefined;

    if (!workspaceId || !session.subscription) {
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const currentPeriodEnd = this.periodEndOf(subscription);

    await this.prisma.subscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: subscriptionId,
        status: 'active',
        currentPeriodEnd,
      },
      update: {
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: subscriptionId,
        status: 'active',
        currentPeriodEnd,
      },
    });

    if (plan) {
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { plan },
      }).catch(() => undefined);
    }

    await this.n8n.notifyPaymentSuccess({
      workspaceId,
      plan: plan ?? 'pro',
      stripeCustomerId: session.customer as string,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: currentPeriodEnd.toISOString(),
      occurredAt: new Date().toISOString(),
    });
  }

  private async onSubscriptionChanged(subscription: Stripe.Subscription): Promise<void> {
    const record = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: subscription.id },
    });
    if (!record) {
      return;
    }

    const status =
      subscription.status === 'canceled'
        ? 'canceled'
        : subscription.status === 'past_due'
          ? 'past_due'
          : 'active';

    await this.prisma.subscription.update({
      where: { id: record.id },
      data: {
        status,
        currentPeriodEnd: this.periodEndOf(subscription),
      },
    });
  }

  /**
   * Resolves the current billing period end (as a Date) from the subscription.
   * The 2026-08-26.dahlia API removed the top-level `current_period_end` field
   * in favour of `billing_schedules[].bill_until`; we fall back to the billing
   * cycle anchor when no schedule is present.
   */
  private periodEndOf(subscription: Stripe.Subscription): Date {
    const billUntil = subscription.billing_schedules?.[0]?.bill_until;
    const epochSeconds =
      billUntil?.timestamp ??
      billUntil?.computed_timestamp ??
      subscription.billing_cycle_anchor;
    return new Date((epochSeconds ?? 0) * 1000);
  }
}
