import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TraceContextService } from '../../../common/logger/trace-context.service';

export const INGESTION_QUEUE = 'ingestion';

export interface IngestionJobPayload {
  contractId: string;
  workspaceId: string;
  fileUrl: string;
  fileHash: string;
  /**
   * Correlation id that also flows into the Python consumer's logs (Part 4.10).
   */
  traceId?: string;
}

@Injectable()
export class IngestionProducer {
  private readonly logger = new Logger(IngestionProducer.name);

  constructor(
    @InjectQueue(INGESTION_QUEUE) private readonly queue: Queue<IngestionJobPayload>,
    private readonly trace: TraceContextService,
  ) {}

  async enqueue(payload: IngestionJobPayload): Promise<{ jobId: string }> {
    const job = await this.queue.add(
      'ingest',
      { ...payload, traceId: payload.traceId ?? this.trace.getTraceId() },
      {
        removeOnComplete: 100,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    );

    this.logger.log(`Enqueued ingestion job ${job.id} for contract ${payload.contractId}`);
    return { jobId: job.id ?? '' };
  }
}
