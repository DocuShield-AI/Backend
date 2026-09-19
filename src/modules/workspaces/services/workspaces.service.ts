import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Plan, Role } from '@prisma/client';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleInvalidationStore } from '../../auth/services/role-invalidation.store';

export interface InviteInput {
  email: string;
  role: Role;
  expiresInDays: number;
  inviterEmail?: string;
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
    private readonly email: EmailService,
  ) {}

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
      select: { id: true, name: true },
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

    await this.email.sendWorkspaceInvite({
      to: input.email.toLowerCase(),
      workspaceName: workspace.name,
      inviteCode: invitation.code,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      inviterEmail: input.inviterEmail,
    });

    return {
      code: invitation.code,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      workspaceId: invitation.workspaceId,
    };
  }

  /**
   * Admin re-assigns a member's role. The target user is scoped to the caller's
   * own workspace in the same query, so an admin can never demote or promote
   * someone in another workspace.
   *
   * The token the member is carrying still says the old role (JWT claims are
   * cached for up to JWT_EXPIRES_IN), so the role row is not touched without
   * also flagging the user in RoleInvalidationStore — that flag makes
   * JwtStrategy re-read this row on the very next request.
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
      select: {
        id: true,
        email: true,
        role: true,
        oauthProvider: true,
        createdAt: true,
      },
    });

    await this.roleInvalidations.invalidate(
      userId,
      this.accessTokenTtlSeconds(),
    );
    return updated;
  }

  /** The access token TTL, parsed from JWT_EXPIRES_IN, defaulting to 15m. */
  private accessTokenTtlSeconds(): number {
    const unitSeconds: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    const raw = (this.config.get<string>('JWT_EXPIRES_IN') ?? '15m').trim();
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return Math.max(1, Math.floor(numeric));
    }
    const value = Number(raw.slice(0, -1));
    const unit = raw[raw.length - 1];
    if (Number.isNaN(value)) {
      return 15 * 60;
    }
    return Math.max(1, Math.floor(value * (unitSeconds[unit] ?? 60)));
  }
}
