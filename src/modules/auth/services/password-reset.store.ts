import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';

export interface PasswordResetRecord {
  userId: string;
  codeHash: string;
}

/** 15 minutes — matches frontend copy. */
export const PASSWORD_RESET_TTL_SECONDS = 15 * 60;

@Injectable()
export class PasswordResetStore {
  private readonly logger = new Logger(PasswordResetStore.name);

  constructor(private readonly cache: RedisCacheService) {}

  private key(email: string): string {
    return `auth:pwd-reset:${email.toLowerCase()}`;
  }

  async save(
    email: string,
    record: PasswordResetRecord,
    ttlSeconds = PASSWORD_RESET_TTL_SECONDS,
  ): Promise<void> {
    await this.run(async () => {
      await this.cache.set(this.key(email), record, ttlSeconds);
    });
  }

  async get(email: string): Promise<PasswordResetRecord | null> {
    return this.run(async () => this.cache.get<PasswordResetRecord>(this.key(email)));
  }

  async delete(email: string): Promise<void> {
    await this.run(async () => {
      await this.cache.del(this.key(email));
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const client = this.cache.Client;
    if (!client) {
      this.logger.error('Password reset store unavailable — Redis not connected');
      throw new ServiceUnavailableException('Password reset service unavailable');
    }
    try {
      return await fn();
    } catch (err) {
      this.logger.error(
        `Password reset store error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Password reset service unavailable');
    }
  }
}
