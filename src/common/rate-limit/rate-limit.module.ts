import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisModule, RedisToken } from '@nestjs-redis/client';
import { RedisThrottlerStorage } from '@nestjs-redis/throttler-storage';
import { APP_GUARD } from '@nestjs/core';
import { WorkspaceThrottlerGuard } from './workspace-throttler.guard';
import type { RedisClientType } from 'redis';

/**
 * Two-tier, Redis-backed rate limiting. In-memory throttling is rejected
 * because it silently doubles the limit when the API scales to 2+ replicas.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [
        RedisModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            options: { url: config.getOrThrow<string>('REDIS_URL') },
          }),
        }),
      ],
      inject: [RedisToken(), ConfigService],
      useFactory: (redis: RedisClientType, config: ConfigService) => ({
        storage: new RedisThrottlerStorage(redis),
        throttlers: [
          // Tier 1 — per-IP (host): coarse flood control at the edge.
          {
            name: 'ip',
            ttl: 60_000,
            limit: Number(config.get('RATE_LIMIT_IP_PER_MINUTE') ?? 100),
          },
          // Tier 2 — per-workspace: guards contract upload + job-status hot
          // paths so one workspace cannot starve the shared queue.
          {
            name: 'workspace',
            ttl: 60_000,
            limit: Number(config.get('RATE_LIMIT_WORKSPACE_PER_MINUTE') ?? 500),
          },
        ],
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: WorkspaceThrottlerGuard },
  ],
})
export class RateLimitModule {}