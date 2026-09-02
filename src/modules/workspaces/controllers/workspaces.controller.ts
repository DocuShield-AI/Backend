import { Controller, Get } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  WorkspaceMember,
  WorkspaceSummary,
  WorkspacesService,
} from '../services/workspaces.service';

/**
 * The workspace is always the caller's own, read from the token. There is no
 * `/workspaces/:id` route by design — an id in the URL is an invitation to
 * pass someone else's.
 */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('me')
  summary(
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<WorkspaceSummary> {
    return this.workspaces.summary(workspaceId);
  }

  // Who else is in the workspace is an administrative detail, not something
  // every viewer needs.
  @Get('me/members')
  @Roles(Role.admin)
  members(
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<WorkspaceMember[]> {
    return this.workspaces.listMembers(workspaceId);
  }
}
