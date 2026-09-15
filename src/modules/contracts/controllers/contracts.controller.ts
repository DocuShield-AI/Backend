import { Controller, Get, Post, Param, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { memoryStorage } from 'multer';
import { ContractsService } from '../services/contracts.service';
import { ContractListItem } from '../repositories/contracts.repository';
import { validateAndHashContract } from '../validators/file-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ListContractsQueryDto } from '../dto/list-contracts-query.dto';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  @Roles(Role.admin, Role.legal)
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthenticatedUser) {
    const { fileName, fileHash } = validateAndHashContract(file);

    if (await this.contractsService.isDuplicate(user.workspaceId, fileHash)) {
      return { duplicate: true, message: 'File already uploaded' };
    }

    const contract = await this.contractsService.uploadContract({
      workspaceId: user.workspaceId,
      uploadedByUserId: user.userId,
      file: { fileName, mimeType: file.mimetype, fileHash },
    });
    return { duplicate: false, contract };
  }

  @Get()
  @Roles(Role.admin, Role.legal, Role.viewer)
  listContracts(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ContractListItem[]> {
    return this.contractsService.listContracts(
      user.workspaceId,
      user.userId,
      user.role,
      query.cursor,
      query.limit,
    );
  }

  @Get(':id')
  @Roles(Role.admin, Role.legal, Role.viewer)
  getContract(@Param('id') id: string, @CurrentUser('workspaceId') workspaceId: string) {
    return this.contractsService.getContract(id, workspaceId);
  }

  @Get(':id/status')
  @Roles(Role.admin, Role.legal, Role.viewer)
  getStatus(@Param('id') id: string, @CurrentUser('workspaceId') workspaceId: string) {
    return this.contractsService.getContractStatus(id, workspaceId);
  }
}