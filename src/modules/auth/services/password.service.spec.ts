import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';

// @nestjs/config v12 ships ESM only, which Jest's CommonJS runtime cannot parse.
// Same workaround the Stripe spec already uses in this repo.
jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

describe('PasswordService', () => {
  // 4 rounds keeps the suite fast; production reads 12 from BCRYPT_SALT_ROUNDS.
  const config = { get: jest.fn(() => '4') } as unknown as ConfigService;
  const service = new PasswordService(config);

  it('produces a bcrypt hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).not.toBe('correct horse battery');
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);
    expect(a).not.toBe(b);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await service.hash('s3cret-password');
    await expect(service.compare('s3cret-password', hash)).resolves.toBe(true);
    await expect(service.compare('wrong-password', hash)).resolves.toBe(false);
  });
});
