import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContext {
  traceId: string;
}

@Injectable()
export class TraceContextService {
  private readonly storage = new AsyncLocalStorage<TraceContext>();

  run<A>(ctx: TraceContext, fn: () => A): A {
    return this.storage.run(ctx, fn);
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }
}
