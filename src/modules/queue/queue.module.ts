import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { IngestionProducer, INGESTION_QUEUE } from './producers/ingestion.producer';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>('REDIS_URL'),
        },
      }),
    }),
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
  ],
  providers: [IngestionProducer],
  exports: [IngestionProducer, BullModule],
})
export class QueueModule {}
