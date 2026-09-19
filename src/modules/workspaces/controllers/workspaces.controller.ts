import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { CreateInviteDto } from '../dto/create-invite.dto';
import { UpdateRoleDto } from '../dto/update-role.dto';
import {
  InviteResult,
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

  /**
   * Admin invites a teammate. The code returned is what the teammate pastes in
   * on signup (`type: "join"`) — the role is baked in at creation time.
   */
  @Post('invite')
  @Roles(Role.admin)
  createInvite(
    @Body() dto: CreateInviteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InviteResult> {
    return this.workspaces.createInvite(user.workspaceId, user.userId, {
      email: dto.email,
      inviterEmail: user.email,
      role: dto.role ?? Role.viewer,
      expiresInDays: dto.expiresInDays ?? 7,
    });
  }

  /**
   * Admin changes a member's role. The member's token still carries the old
   * role until it expires; the service flags the change so the very next
   * request uses the fresh role (see RoleInvalidationStore).
   */
  @Patch('me/members/:userId/role')
  @Roles(Role.admin)
  updateRole(
    @Param('userId') userId: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser('workspaceId') workspaceId: string,
  ): Promise<WorkspaceMember> {
    return this.workspaces.updateRole(workspaceId, userId, dto.role);
  }
}
