import { Test } from '@nestjs/testing';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { PrismaService } from '../../prisma/prisma.service';
import { N8nWebhookClient } from '../../notifications/n8n-webhook.client';

jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

describe('StripeService', () => {
  let service: StripeService;
  let prisma: { subscription: any; workspace: any };
  let n8n: { notifyPaymentSuccess: jest.Mock };

  const webhookSecret = 'whsec_test_123';
  const secretKey = 'sk_test_123';

  const stubStripe = () => {
    const real = new Stripe(secretKey, {
      apiVersion: '2026-08-26.dahlia',
    });

    service['stripe'] = real;
    return real;
  };

  beforeEach(async () => {
    prisma = {
      subscription: {
        upsert: jest.fn().mockResolvedValue({ id: 'sub_1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'sub_1', currentPeriodEnd: new Date() }),
        update: jest.fn().mockResolvedValue({ id: 'sub_1' }),
      },
      workspace: {
        update: jest.fn().mockResolvedValue({ id: 'ws_1' }),
      },
    };

    const config = {
      getOrThrow: jest.fn((key: string) => {
        switch (key) {
          case 'STRIPE_SECRET_KEY':
            return secretKey;
          case 'STRIPE_WEBHOOK_SECRET':
            return webhookSecret;
          default:
            throw new Error(`Unexpected config key: ${key}`);
        }
      }),
      get: jest.fn(() => undefined),
    };

    n8n = { notifyPaymentSuccess: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: N8nWebhookClient, useValue: n8n },
      ],
    }).compile();

    service = moduleRef.get(StripeService);
    stubStripe();
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a validly signed event', async () => {
      const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' });
      const header = service['stripe'].webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });

      await expect(
        service.verifyWebhookSignature(Buffer.from(payload), header),
      ).resolves.toMatchObject({ id: 'evt_1' });
    });

    it('rejects a tampered payload even with a signature header', async () => {
      const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' });
      const header = service['stripe'].webhooks.generateTestHeaderString({
        payload,
        secret: webhookSecret,
      });

      const tampered = JSON.stringify({ id: 'evt_2', object: 'event', type: 'x' });

      await expect(
        service.verifyWebhookSignature(Buffer.from(tampered), header),
      ).rejects.toThrow();
    });

    it('rejects a request with a missing signature header', async () => {
      const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' });
      await expect(
        service.verifyWebhookSignature(Buffer.from(payload), undefined),
      ).rejects.toThrow('Missing Stripe signature');
    });

    it('rejects a signature produced with the wrong secret', async () => {
      const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'x' });
      const header = service['stripe'].webhooks.generateTestHeaderString({
        payload,
        secret: 'whsec_wrong',
      });

      await expect(
        service.verifyWebhookSignature(Buffer.from(payload), header),
      ).rejects.toThrow();
    });
  });

  describe('handleEvent / checkout completion', () => {
    it('is a no-op for unhandled event types', async () => {
      await expect(
        service.handleEvent({ type: 'ping' } as Stripe.Event),
      ).resolves.toBeUndefined();
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('persists an active subscription on checkout.session.completed', async () => {
      const session = {
        id: 'cs_1',
        metadata: { workspaceId: 'ws_1', plan: 'pro' },
        customer: 'cus_1',
        subscription: 'sub_x',
        object: 'checkout.session',
      } as unknown as Stripe.Checkout.Session;

      const sub: Partial<Stripe.Subscription> = {
        id: 'sub_x',
        status: 'active',
        current_period_end: undefined,
        billing_schedules: [
          {
            applies_to: null,
            key: 'schedule-0',
            bill_until: {
              computed_timestamp: 1_800_000_000,
              duration: null,
              timestamp: 1_800_000_000,
              type: 'timestamp',
            },
          },
        ],
      };
      (service as unknown as {
        stripe: { subscriptions: { retrieve: (id: string) => Promise<Stripe.Subscription> } };
      }).stripe.subscriptions.retrieve = jest.fn().mockResolvedValue(sub);

      const event = {
        type: 'checkout.session.completed',
        data: { object: session },
      } as Stripe.Event;

      await service.handleEvent(event);

      expect(prisma.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: 'ws_1' },
          create: expect.objectContaining({
            stripeCustomerId: 'cus_1',
            stripeSubscriptionId: 'sub_x',
            status: 'active',
          }),
        }),
      );
      const arg = prisma.subscription.upsert.mock.calls[0][0];
      expect(arg.create.currentPeriodEnd).toEqual(new Date(1_800_000_000 * 1000));

      expect(n8n.notifyPaymentSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_1',
          plan: 'pro',
          stripeSubscriptionId: 'sub_x',
        }),
      );
    });
  });
});
