import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Plan, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleInvalidationStore } from '../../auth/services/role-invalidation.store';
import { parseDurationToSeconds } from '../../../common/utils/parse-duration';

export interface InviteInput {
  role: Role;
  expiresInDays: number;
}

export interface InviteResult {
  code: string;
  role: Role;
  expiresAt: Date;
  workspaceId: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: Plan;
  createdAt: Date;
  memberCount: number;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  role: Role;
  oauthProvider: string | null;
  createdAt: Date;
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly roleInvalidations: RoleInvalidationStore,
  ) {}

  // Workspace id always comes from the caller's token, never from a route param
  // or body, so cross-tenant lookup is structurally impossible.
  async summary(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { _count: { select: { users: true } } },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      createdAt: workspace.createdAt,
      memberCount: workspace._count.users,
    };
  }

  listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    // passwordHash is never selected, so it cannot escape through this route.
    return this.prisma.user.findMany({
      where: { workspaceId },
      select: { id: true, email: true, role: true, oauthProvider: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createInvite(
    workspaceId: string,
    createdByUserId: string,
    input: InviteInput,
  ): Promise<InviteResult> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // 12 hex chars (48 bits of entropy) is plenty for a short-lived single-use code.
    const code = randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.invitation.create({
      data: { workspaceId, code, role: input.role, createdByUserId, expiresAt },
    });

    return {
      code: invitation.code,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      workspaceId: invitation.workspaceId,
    };
  }

  /**
   * Target user is scoped to the caller's workspace in the same query, and the
   * change is flagged in RoleInvalidationStore so the next request picks it up
   * before the member's access token (whose claims still say the old role) expires.
   */
  async updateRole(
    workspaceId: string,
    userId: string,
    role: Role,
  ): Promise<WorkspaceMember> {
    const member = await this.prisma.user.findFirst({
      where: { id: userId, workspaceId },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundException('User not found in this workspace');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, email: true, role: true, oauthProvider: true, createdAt: true },
    });

    await this.roleInvalidations.invalidate(userId, this.accessTokenTtlSeconds());
    return updated;
  }

  private accessTokenTtlSeconds(): number {
    const raw = (this.config.get<string>('JWT_EXPIRES_IN') ?? '15m').trim();
    const seconds = parseDurationToSeconds(raw);
    return Number.isFinite(seconds) ? Math.max(1, Math.floor(seconds)) : 15 * 60;
  }
}