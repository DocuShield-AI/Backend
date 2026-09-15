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
  ingestionJob?: { stage: string } | null;
}

export interface ContractListItem {
  id: string;
  fileName: string;
  status: string;
  stage: string | null;
  uploadedByUserId: string;
  createdAt: Date;
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
      data: { ...input, status: 'queued' },
    });
  }

  createIngestionJob(input: { contractId: string; bullmqJobId: string }) {
    return this.prisma.ingestionJob.create({
      data: { contractId: input.contractId, bullmqJobId: input.bullmqJobId, stage: 'extract', attempts: 0 },
    });
  }

  findByHash(workspaceId: string, fileHash: string) {
    return this.prisma.contract.findUnique({
      where: { uniq_contract_per_workspace_hash: { workspaceId, fileHash } },
      select: { id: true },
    });
  }

  remove(id: string) {
    return this.prisma.contract.delete({ where: { id } });
  }

  async list(
    workspaceId: string,
    uploadedByUserId?: string,
    cursor?: string,
    limit = 20,
  ): Promise<ContractListItem[]> {
    const rows = await this.prisma.contract.findMany({
      where: { workspaceId, ...(uploadedByUserId ? { uploadedByUserId } : {}) },
      select: {
        id: true,
        fileName: true,
        status: true,
        uploadedByUserId: true,
        createdAt: true,
        ingestionJob: { select: { stage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    return items.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      status: row.status,
      stage: row.ingestionJob?.stage ?? null,
      uploadedByUserId: row.uploadedByUserId,
      createdAt: row.createdAt,
    }));
  }

  findByIdWithIngestion(
    contractId: string,
    workspaceId: string,
  ): Promise<ContractWithIngestion | null> {
    return this.prisma.contract.findFirst({
      where: { id: contractId, workspaceId },
      include: { ingestionJob: true },
    });
  }
}