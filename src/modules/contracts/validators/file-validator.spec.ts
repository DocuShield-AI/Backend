import { BadRequestException } from '@nestjs/common';
import {
  validateAndHashContract,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
} from './file-validator';

const makeFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'nda.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    buffer: Buffer.from('fake contract bytes'),
    size: Buffer.from('fake contract bytes').length,
    ...overrides,
  }) as Express.Multer.File;

describe('validateAndHashContract', () => {
  it('accepts a valid PDF and computes a stable sha256 hash', () => {
    const result = validateAndHashContract(makeFile());
    expect(result.mimeType).toBe('application/pdf');
    expect(result.fileHash).toHaveLength(64);
    expect(result.fileHash).toMatch(/^[a-f0-9]{64}$/);

    // Same content -> same hash
    const again = validateAndHashContract(makeFile());
    expect(again.fileHash).toBe(result.fileHash);
  });

  it('rejects when no file is provided', () => {
    expect(() => validateAndHashContract(undefined)).toThrow(BadRequestException);
  });

  it('rejects unsupported MIME types', () => {
    expect(() =>
      validateAndHashContract(makeFile({ mimetype: 'text/plain' })),
    ).toThrow(BadRequestException);
  });

  it('rejects files over the size limit', () => {
    const oversized = makeFile({
      size: MAX_FILE_SIZE_BYTES + 1,
      buffer: Buffer.alloc(MAX_FILE_SIZE_BYTES + 1),
    });
    expect(() => validateAndHashContract(oversized)).toThrow(BadRequestException);
  });

  it('allows common contract MIME types', () => {
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf');
    expect(ALLOWED_MIME_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});
