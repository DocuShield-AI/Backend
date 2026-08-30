import {
  Controller,
  Get,
  Post,
  Param,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ContractsService } from '../services/contracts.service';
import { validateAndHashContract } from '../validators/file-validator';

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
  async upload(@UploadedFile() file: Express.Multer.File) {
    const { fileName, fileHash } = validateAndHashContract(file);

    // Placeholder workspace/user until auth is wired; replaced by Shanza's
    // guards (JwtAuthGuard / RolesGuard) which supply the current user.
    const workspaceId = 'workspace-placeholder';
    const uploadedByUserId = 'user-placeholder';

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
  getContract(@Param('id') id: string) {
    return this.contractsService.getContract(id);
  }

  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.contractsService.getContractStatus(id);
  }
}
