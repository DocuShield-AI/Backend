import { Module } from '@nestjs/common';
import { WorkspacesController } from './controllers/workspaces.controller';
import { WorkspacesService } from './services/workspaces.service';

/**
 * Workspace domain — tenancy reads that other modules can lean on. The
 * per-workspace scoping of contracts lives in the contracts repository's query
 * filter; this module covers the workspace's own data and membership.
 */
@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
