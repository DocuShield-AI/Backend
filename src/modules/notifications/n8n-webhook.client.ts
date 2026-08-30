import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PaymentSuccessWebhookPayload {
  workspaceId: string;
  plan: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEnd: string;
  occurredAt: string;
}

@Injectable()
export class N8nWebhookClient {
  private readonly logger = new Logger(N8nWebhookClient.name);
  private readonly url: string;

  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>('N8N_WEBHOOK_URL') ?? '';
  }

  /**
   * Posts a payment-success event to Annas's n8n automation.
   * This payload shape is the contract the n8n workflow consumes.
   */
  async notifyPaymentSuccess(payload: PaymentSuccessWebhookPayload): Promise<void> {
    if (!this.url) {
      this.logger.warn(
        'N8N_WEBHOOK_URL not configured; skipping payment-success notification',
      );
      return;
    }

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'payment.success', ...payload }),
      });
      if (!res.ok) {
        this.logger.error(
          `n8n webhook returned ${res.status} for workspace ${payload.workspaceId}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to notify n8n for workspace ${payload.workspaceId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
