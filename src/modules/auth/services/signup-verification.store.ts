import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import type { SignupType } from '../dto/signup.dto';

export interface SignupVerificationRecord {
  codeHash: string;
  passwordHash: string;
  type: SignupType;
  workspaceName?: string;
  inviteCode?: string;
}

/** 15 minutes — matches frontend copy. */
export const SIGNUP_VERIFICATION_TTL_SECONDS = 15 * 60;

@Injectable()
export class SignupVerificationStore {
  private readonly logger = new Logger(SignupVerificationStore.name);

  constructor(private readonly cache: RedisCacheService) {}

  private key(email: string): string {
    return `auth:signup-verify:${email.toLowerCase()}`;
  }

  async save(
    email: string,
    record: SignupVerificationRecord,
    ttlSeconds = SIGNUP_VERIFICATION_TTL_SECONDS,
  ): Promise<void> {
    await this.run(async () => {
      await this.cache.set(this.key(email), record, ttlSeconds);
    });
  }

  async get(email: string): Promise<SignupVerificationRecord | null> {
    return this.run(async () => this.cache.get<SignupVerificationRecord>(this.key(email)));
  }

  async delete(email: string): Promise<void> {
    await this.run(async () => {
      await this.cache.del(this.key(email));
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const client = this.cache.Client;
    if (!client) {
      this.logger.error('Signup verification store unavailable — Redis not connected');
      throw new ServiceUnavailableException('Signup verification service unavailable');
    }
    try {
      return await fn();
    } catch (err) {
      this.logger.error(
        `Signup verification store error: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('Signup verification service unavailable');
    }
  }
}
