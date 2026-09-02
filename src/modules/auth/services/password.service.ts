import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

/**
 * Password hashing, isolated behind one service so the algorithm and cost
 * factor can change in a single place. Cost is read from config because a
 * higher factor is wanted in production than in tests, where 12 rounds would
 * dominate the suite's runtime.
 */
@Injectable()
export class PasswordService {
  private readonly rounds: number;

  constructor(private readonly config: ConfigService) {
    this.rounds = Number(this.config.get<string>('BCRYPT_SALT_ROUNDS') ?? 12);
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
