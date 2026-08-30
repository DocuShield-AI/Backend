import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { TraceContextService } from './trace-context.service';

@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  constructor(private readonly trace: TraceContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const traceId =
      (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', traceId);
    this.trace.run({ traceId }, () => next());
  }
}
