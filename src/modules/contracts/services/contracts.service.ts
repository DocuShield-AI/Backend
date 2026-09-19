import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ContractStatus, Role } from '@prisma/client';
import { IngestionProducer } from '../../queue/producers/ingestion.producer';
import {
  ContractsRepository,
  ContractListItem,
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
    try {
      const { jobId } = await this.producer.enqueue({ contractId: contract.id, workspaceId, fileUrl, fileHash: file.fileHash });
      await this.repository.createIngestionJob({ contractId: contract.id, bullmqJobId: jobId });
    } catch (err) {
      await this.repository.remove(contract.id).catch(() => undefined);
      this.logger.error(
        `Contract ${contract.id} enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new InternalServerErrorException('Failed to queue contract for processing');
    }

    this.logger.log(`Contract ${contract.id} queued for ingestion`);
    return contract;
  }

  async isDuplicate(workspaceId: string, fileHash: string): Promise<boolean> {
    return Boolean(await this.repository.findByHash(workspaceId, fileHash));
  }

  listContracts(
    workspaceId: string,
    userId: string,
    role: Role,
    cursor?: string,
    limit = 20,
  ): Promise<ContractListItem[]> {
    return this.repository.list(workspaceId, role === Role.viewer ? userId : undefined, cursor, limit);
  }

  // 404, not 403: avoids confirming the id exists in another tenant.
  async getContract(contractId: string, workspaceId: string): Promise<ContractWithIngestion> {
    const contract = await this.repository.findByIdWithIngestion(contractId, workspaceId);
    if (!contract) {
      throw new NotFoundException('Contract not found');
    }
    return contract;
  }

  async getContractStatus(
    contractId: string,
    workspaceId: string,
  ): Promise<{ status: ContractStatus; stage: string | null }> {
    const contract = await this.getContract(contractId, workspaceId);
    return { status: contract.status as ContractStatus, stage: contract.ingestionJob?.stage ?? null };
  }
}