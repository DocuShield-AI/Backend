import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface ValidatedFile {
  fileName: string;
  mimeType: string;
  fileHash: string;
}

/**
 * Validates an uploaded contract file: MIME allow-list, size cap, and computes
 * its SHA-256 content hash for idempotent uploads (no double-billing).
 */
export function validateAndHashContract(
  file: Express.Multer.File | undefined,
): ValidatedFile {
  if (!file) {
    throw new BadRequestException('No file uploaded');
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new BadRequestException('File exceeds the 25 MB size limit');
  }

  const fileHash = createHash('sha256').update(file.buffer).digest('hex');

  return { fileName: file.originalname, mimeType: file.mimetype, fileHash };
}
