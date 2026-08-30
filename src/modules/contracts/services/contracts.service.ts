import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ContractStatus } from '@prisma/client';
import { IngestionProducer } from '../../queue/producers/ingestion.producer';
import {
  ContractsRepository,
  ContractWithIngestion,
} from '../repositories/contracts.repository';
import { ValidatedFile } from '../validators/file-validator';

export interface CreateContractInput {
  workspaceId: string;
  uploadedByUserId: string;
  file: ValidatedFile;
}

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly repository: ContractsRepository,
    private readonly producer: IngestionProducer,
  ) {}

  /**
   * Creates a contract record after idempotent hash-dedupe, then enqueues the
   * ingestion job for the AI microservice.
   */
  async uploadContract(input: CreateContractInput) {
    const { workspaceId, uploadedByUserId, file } = input;
    const fileUrl = `s3://contracts/${workspaceId}/${file.fileName}`;

    const contract = await this.repository.create({
      workspaceId,
      uploadedByUserId,
      fileName: file.fileName,
      fileHash: file.fileHash,
      fileUrl,
    });

    const { jobId } = await this.producer.enqueue({
      contractId: contract.id,
      workspaceId,
      fileUrl,
      fileHash: file.fileHash,
    });

    await this.repository.createIngestionJob({
      contractId: contract.id,
      bullmqJobId: jobId,
    });

    this.logger.log(
      `Contract ${contract.id} queued for ingestion (job ${jobId})`,
    );
    return contract;
  }

  /**
   * Returns true when the exact same file (by SHA-256) already exists in the
   * workspace, enabling idempotent uploads without double-billing.
   */
  async isDuplicate(workspaceId: string, fileHash: string): Promise<boolean> {
    const existing = await this.repository.findByHash(workspaceId, fileHash);
    return Boolean(existing);
  }

  async getContract(
    contractId: string,
  ): Promise<ContractWithIngestion | null> {
    const contract = await this.repository.findByIdWithIngestion(contractId);
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }
    return contract;
  }

  /**
   * Job-status polling endpoint — tracks queued → extracting → embedding →
   * classifying → ready.
   */
  async getContractStatus(
    contractId: string,
  ): Promise<{ status: ContractStatus; stage: string | null }> {
    const contract = await this.getContract(contractId);
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }
    return {
      status: contract.status as ContractStatus,
      stage: contract.ingestionJob?.stage ?? null,
    };
  }
}
