import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Plan, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every read here takes the workspace id from the caller's token, never from
   * a route parameter — there is deliberately no "fetch workspace X" method for
   * a controller to accidentally call with someone else's id.
   */
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
    return this.prisma.user.findMany({
      where: { workspaceId },
      // passwordHash is never selected, so it cannot escape through this route.
      select: {
        id: true,
        email: true,
        role: true,
        oauthProvider: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Defence in depth for anything that cannot rely on a query filter. Token
   * claims are trusted for 15 minutes (see JwtStrategy), so a membership that
   * was revoked inside that window is only caught by an explicit check.
   */
  async isMember(userId: string, workspaceId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, workspaceId },
      select: { id: true },
    });
    return user !== null;
  }

  /**
   * Generates a single-use invite for a teammate. The admin id comes from the
   * verified token, and the workspace from the same token — neither trusts a
   * request body or URL.
   */
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

    // 12 hex chars (48 bits of entropy) is plenty for a short-lived, single-use
    // code and stays easy to read aloud / type into a join form.
    const code = randomBytes(6).toString('hex').toUpperCase();
    const expiresAt = new Date(
      Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
    );

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
}
