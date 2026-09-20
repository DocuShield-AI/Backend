import { Global, Module } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { TraceContextService } from './trace-context.service';
import { TraceIdMiddleware } from './trace-id.middleware';

const isProduction = process.env.NODE_ENV === 'production';

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
        // JSON in production for log aggregators; human-readable lines locally.
        ...(isProduction
          ? {}
          : {
              transport: {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                  translateTime: 'HH:MM:ss',
                  ignore: 'pid,hostname',
                },
              },
              serializers: {
                req: (req: IncomingMessage & { id?: string; method?: string; url?: string }) => ({
                  id: req.id,
                  method: req.method,
                  url: req.url,
                }),
                res: (res: ServerResponse) => ({
                  statusCode: res.statusCode,
                }),
              },
            }),
      },
    }),
  ],
  providers: [TraceContextService, TraceIdMiddleware],
  exports: [TraceContextService],
})
export class LoggerModule {}
