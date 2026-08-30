import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';
import { WorkspaceThrottlerGuard } from './workspace-throttler.guard';

/**
 * Two-tier, Redis-backed rate limiting (Part 4.1). In-memory throttling is
 * rejected because it silently doubles the limit when the API scales to 2+
 * replicas. Both tiers share one Redis counter store.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: new ThrottlerStorageRedisService(
          config.getOrThrow<string>('REDIS_URL'),
        ),
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
