import { NotFoundException } from '@nestjs/common';

// @nestjs/bullmq is ESM only and reaches this file through the producer import.
// Same stand-in the ingestion producer spec already uses.
jest.mock('@nestjs/bullmq', () => {
  const { Inject } = require('@nestjs/common') as typeof import('@nestjs/common');
  return { InjectQueue: (name: string) => Inject(`BullQueue_${name}`) };
});

import { ContractsRepository } from '../repositories/contracts.repository';
import { IngestionProducer } from '../../queue/producers/ingestion.producer';
import { ContractsService } from './contracts.service';

/**
 * Covers workspace scoping only — the tenancy boundary added with auth. The
 * upload/dedupe behaviour these methods sit next to is exercised elsewhere.
 */
describe('ContractsService — workspace scoping', () => {
  let repository: any;
  let producer: any;
  let service: ContractsService;

  const contract = {
    id: 'c_1',
    workspaceId: 'ws_mine',
    uploadedByUserId: 'u_1',
    fileName: 'nda.pdf',
    fileHash: 'abc',
    fileUrl: 's3://x',
    status: 'queued',
    createdAt: new Date(),
    ingestionJob: { stage: 'extract' },
  };

  beforeEach(() => {
    repository = { findByIdWithIngestion: jest.fn() };
    producer = { enqueue: jest.fn() };
    service = new ContractsService(
      repository as ContractsRepository,
      producer as IngestionProducer,
    );
  });

  it('asks the repository for the contract within the caller workspace', async () => {
    repository.findByIdWithIngestion.mockResolvedValue(contract);

    await service.getContract('c_1', 'ws_mine');

    // The workspace must reach the query, not be checked after the fact.
    expect(repository.findByIdWithIngestion).toHaveBeenCalledWith('c_1', 'ws_mine');
  });

  it('404s for a contract that belongs to another workspace', async () => {
    // The scoped query finds nothing, because the row is not this tenant's.
    repository.findByIdWithIngestion.mockResolvedValue(null);

    await expect(service.getContract('c_1', 'ws_other')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('gives a foreign contract the same answer as one that does not exist', async () => {
    repository.findByIdWithIngestion.mockResolvedValue(null);

    const foreign = await service
      .getContract('c_1', 'ws_other')
      .catch((e: Error) => e.message);
    const missing = await service
      .getContract('c_nonexistent', 'ws_mine')
      .catch((e: Error) => e.message);

    // A distinguishable error would confirm the id exists in another tenant.
    expect(foreign).toBe(missing);
  });

  it('scopes the status endpoint too', async () => {
    repository.findByIdWithIngestion.mockResolvedValue(contract);

    await expect(service.getContractStatus('c_1', 'ws_mine')).resolves.toEqual({
      status: 'queued',
      stage: 'extract',
    });
    expect(repository.findByIdWithIngestion).toHaveBeenCalledWith('c_1', 'ws_mine');
  });

  it('does not leak status for another workspace', async () => {
    repository.findByIdWithIngestion.mockResolvedValue(null);

    await expect(service.getContractStatus('c_1', 'ws_other')).rejects.toThrow(
      NotFoundException,
    );
  });
});
