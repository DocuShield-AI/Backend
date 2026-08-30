import { Test } from '@nestjs/testing';
import { TraceContextService } from '../../../common/logger/trace-context.service';
import {
  IngestionProducer,
  IngestionJobPayload,
  INGESTION_QUEUE,
} from './ingestion.producer';

jest.mock('@nestjs/bullmq', () => {
  const { Inject } = require('@nestjs/common') as typeof import('@nestjs/common');
  return {
    InjectQueue: (name: string) => Inject(`BullQueue_${name}`),
  };
});

describe('IngestionProducer (queue contract, Part 7.1)', () => {
  const queue = { add: jest.fn() };
  const trace = { getTraceId: jest.fn(() => 'trace-123') };

  beforeEach(async () => {
    jest.clearAllMocks();
    queue.add.mockResolvedValue({ id: 'job_1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        IngestionProducer,
        { provide: TraceContextService, useValue: trace },
        { provide: 'BullQueue_ingestion', useValue: queue },
      ],
    }).compile();

    producer = moduleRef.get(IngestionProducer);
  });

  let producer: IngestionProducer;

  it('uses the registered ingestion queue', () => {
    expect(INGESTION_QUEUE).toBe('ingestion');
  });

  it('enqueues the documented payload contract and returns the job id', async () => {
    const payload: IngestionJobPayload = {
      contractId: 'c_1',
      workspaceId: 'ws_1',
      fileUrl: 's3://contracts/ws_1/nda.pdf',
      fileHash: 'abc123',
    };

    const result = await producer.enqueue(payload);

    expect(queue.add).toHaveBeenCalledWith(
      'ingest',
      expect.objectContaining({
        contractId: 'c_1',
        workspaceId: 'ws_1',
        fileUrl: 's3://contracts/ws_1/nda.pdf',
        fileHash: 'abc123',
        // traceId is injected from the current request context (Part 4.10).
        traceId: 'trace-123',
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      }),
    );

    // Lock the exact key set so the Python consumer's parser cannot silently
    // change shape without this test failing.
    const sent = queue.add.mock.calls[0][1];
    expect(Object.keys(sent).sort()).toEqual([
      'contractId',
      'fileHash',
      'fileUrl',
      'traceId',
      'workspaceId',
    ]);

    expect(result).toEqual({ jobId: 'job_1' });
  });

  it('prefers an explicitly provided traceId over the ambient context', async () => {
    await producer.enqueue({
      contractId: 'c_1',
      workspaceId: 'ws_1',
      fileUrl: 's3://x',
      fileHash: 'h',
      traceId: 'explicit-trace',
    });

    const sent = queue.add.mock.calls[0][1];
    expect(sent.traceId).toBe('explicit-trace');
  });
});
