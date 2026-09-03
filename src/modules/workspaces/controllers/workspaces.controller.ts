import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  WorkspaceMember,
  WorkspaceSummary,
  WorkspacesService,
} from '../services/workspaces.service';
import { CreateMemberDto } from '../dto/create-member.dto';
import { UpdateMemberRoleDto } from '../dto/update-member-role.dto';

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

  /**
   * Adds a teammate with a chosen role. Without this, signup's "every account
   * is an admin of a new workspace" rule left legal and viewer unreachable.
   */
  @Post('me/members')
  @Roles(Role.admin)
  addMember(
    @Body() dto: CreateMemberDto,
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<WorkspaceMember> {
    return this.workspaces.createMember(workspaceId, dto);
  }

  @Patch('me/members/:id/role')
  @Roles(Role.admin)
  changeMemberRole(
    @Param('id') memberId: string,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<WorkspaceMember> {
    return this.workspaces.updateMemberRole(workspaceId, memberId, dto.role);
  }
}
