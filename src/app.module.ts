import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from './common/logger/logger.module';
import { TraceIdMiddleware } from './common/logger/trace-id.middleware';
import { CacheModule } from './common/cache/cache.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { QueueModule } from './modules/queue/queue.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Cross-cutting infra (all global).
    LoggerModule,
    CacheModule,
    RateLimitModule,
    // Feature modules.
    PrismaModule,
    QueueModule,
    NotificationsModule,
    SubscriptionsModule,
    ContractsModule,
    WorkspacesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Correlation-id middleware on every route (Part 4.10).
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
