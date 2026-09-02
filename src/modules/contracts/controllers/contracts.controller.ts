import {
  Controller,
  Get,
  Post,
  Param,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { memoryStorage } from 'multer';
import { ContractsService } from '../services/contracts.service';
import { validateAndHashContract } from '../validators/file-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  // Viewers are read-only by definition, so uploading is limited to the two
  // roles that act on contracts.
  @Roles(Role.admin, Role.legal)
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { fileName, fileHash } = validateAndHashContract(file);

    // Both ids come from the verified token. They are real rows, which is what
    // stops the contracts.workspace_id / uploaded_by_user_id foreign keys from
    // rejecting the insert.
    const workspaceId = user.workspaceId;
    const uploadedByUserId = user.userId;

    const isDuplicate = await this.contractsService.isDuplicate(
      workspaceId,
      fileHash,
    );
    if (isDuplicate) {
      return { duplicate: true, message: 'File already uploaded' };
    }

    const contract = await this.contractsService.uploadContract({
      workspaceId,
      uploadedByUserId,
      file: { fileName, mimeType: file.mimetype, fileHash },
    });

    return { duplicate: false, contract };
  }

  @Get(':id')
  getContract(
    @Param('id') id: string,
    @CurrentUser('workspaceId') workspaceId: string,
  ) {
    return this.contractsService.getContract(id, workspaceId);
  }

  @Get(':id/status')
  getStatus(
    @Param('id') id: string,
    @CurrentUser('workspaceId') workspaceId: string,
  ) {
    return this.contractsService.getContractStatus(id, workspaceId);
  }
}
