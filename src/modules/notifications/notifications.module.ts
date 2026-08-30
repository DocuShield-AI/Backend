import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { N8nWebhookClient } from './n8n-webhook.client';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [N8nWebhookClient],
  exports: [N8nWebhookClient],
})
export class NotificationsModule {}
