import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ContractWithIngestion {
  id: string;
  workspaceId: string;
  uploadedByUserId: string;
  fileName: string;
  fileHash: string;
  fileUrl: string;
  status: string;
  createdAt: Date;
  ingestionJob?: {
    stage: string;
  } | null;
}

@Injectable()
export class ContractsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: {
    workspaceId: string;
    uploadedByUserId: string;
    fileName: string;
    fileHash: string;
    fileUrl: string;
  }) {
    return this.prisma.contract.create({
      data: {
        workspaceId: input.workspaceId,
        uploadedByUserId: input.uploadedByUserId,
        fileName: input.fileName,
        fileHash: input.fileHash,
        fileUrl: input.fileUrl,
        status: 'queued',
      },
    });
  }

  createIngestionJob(input: {
    contractId: string;
    bullmqJobId: string;
  }) {
    return this.prisma.ingestionJob.create({
      data: {
        contractId: input.contractId,
        bullmqJobId: input.bullmqJobId,
        stage: 'extract',
        attempts: 0,
      },
    });
  }

  findByHash(workspaceId: string, fileHash: string) {
    return this.prisma.contract.findUnique({
      where: {
        uniq_contract_per_workspace_hash: { workspaceId, fileHash },
      },
      select: { id: true },
    });
  }

  findByIdWithIngestion(
    contractId: string,
  ): Promise<ContractWithIngestion | null> {
    return this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { ingestionJob: true },
    });
  }
}
