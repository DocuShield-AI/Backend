import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { N8nWebhookClient } from './n8n-webhook.client';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [N8nWebhookClient, EmailService],
  exports: [N8nWebhookClient, EmailService],
})
export class NotificationsModule {}
