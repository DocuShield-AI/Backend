import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { N8nWebhookClient } from '../../notifications/n8n-webhook.client';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import { SubscriptionStatus } from '@prisma/client';

const WEBHOOK_DEDUP_TTL_SECONDS = 60 * 60 * 24;

export interface CheckoutInput {
  workspaceId: string;
  plan: 'pro' | 'enterprise';
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly n8n: N8nWebhookClient,
    private readonly cache: RedisCacheService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
    if (!key) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not set — billing routes will answer 503 until configured',
      );
      this.stripe = null;
    } else {
      this.stripe = new Stripe(key, { apiVersion: '2026-08-26.dahlia' });
    }
  }

  private requireStripe(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Stripe is not configured');
    }
    return this.stripe;
  }

  private priceIdForPlan(plan: CheckoutInput['plan']): string {
    return this.config.getOrThrow<string>(`STRIPE_PRICE_${plan.toUpperCase()}`);
  }

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
    const baseUrl = this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:4000';

    const session = await this.requireStripe().checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: this.priceIdForPlan(input.plan), quantity: 1 }],
        metadata: { workspaceId: input.workspaceId, plan: input.plan },
        success_url: `${baseUrl}/subscriptions/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/subscriptions/cancel`,
      },
      { idempotencyKey: `checkout-${input.workspaceId}-${input.plan}` },
    );

    return { url: session.url as string, sessionId: session.id };
  }

  async verifyWebhookSignature(
    payload: Buffer | string,
    signature: string | undefined,
  ): Promise<Stripe.Event> {
    if (!signature) {
      throw new Error('Missing Stripe signature header');
    }
    return this.requireStripe().webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  /**
   * Stripe can deliver the same event more than once (retries). The event id is
   * recorded only after the handler succeeds, so a mid-way failure keeps the
   * event unmarked and a retry can still process it.
   */
  async handleEvent(event: Stripe.Event): Promise<void> {
    const dedupKey = `stripe:event:${event.id}`;
    if (await this.cache.exists(dedupKey)) {
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.onSubscriptionChanged(event.data.object as Stripe.Subscription);
        break;
      default:
        return;
    }

    await this.cache.set(dedupKey, '1', WEBHOOK_DEDUP_TTL_SECONDS);
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const workspaceId = session.metadata?.workspaceId;
    const plan = session.metadata?.plan as 'pro' | 'enterprise' | undefined;

    if (!workspaceId || !session.subscription) {
      return;
    }
    if (!plan) {
      this.logger.warn(`Checkout ${session.id} missing plan metadata`);
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription.id;

    const subscription = await this.requireStripe().subscriptions.retrieve(subscriptionId);
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

    await this.prisma.workspace
      .update({
        where: { id: workspaceId },
        data: { plan },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Failed to upgrade workspace ${workspaceId} to plan ${plan}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    await this.n8n.notifyPaymentSuccess({
      workspaceId,
      plan,
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

    const status: SubscriptionStatus =
      subscription.status === 'canceled'
        ? 'canceled'
        : subscription.status === 'past_due'
          ? 'past_due'
          : 'active';

    await this.prisma.subscription.update({
      where: { id: record.id },
      data: { status, currentPeriodEnd: this.periodEndOf(subscription) },
    });
  }

  /**
   * The 2026-08-26.dahlia API removed the top-level `current_period_end` field
   * in favour of `billing_schedules[].bill_until`; falls back to the billing
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
