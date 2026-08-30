import { Global, Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { TraceContextService } from './trace-context.service';
import { TraceIdMiddleware } from './trace-id.middleware';

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        // Reuse the inbound x-request-id (correlation id) or mint a fresh one,
        // so the same id appears as `req.id` in every request log and can be
        // propagated to BullMQ job payloads via TraceContextService.
        genReqId: (req) =>
          (req.headers?.['x-request-id'] as string) || randomUUID(),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        level: process.env.LOG_LEVEL ?? 'info',
      },
    }),
  ],
  providers: [TraceContextService, TraceIdMiddleware],
  exports: [TraceContextService],
})
export class LoggerModule {}
