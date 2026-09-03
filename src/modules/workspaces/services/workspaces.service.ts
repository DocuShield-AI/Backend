import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Plan, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../../auth/services/password.service';
import { CreateMemberDto } from '../dto/create-member.dto';

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
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
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
   * Adds a teammate to the caller's workspace with an explicit role.
   *
   * Signup deliberately makes every new account the admin of a brand new
   * workspace, which left `legal` and `viewer` unreachable — the @Roles checks
   * on uploads and billing were guarding against users that could not exist.
   * This is the endpoint that makes those roles real.
   */
  async createMember(
    workspaceId: string,
    dto: CreateMemberDto,
  ): Promise<WorkspaceMember> {
    const passwordHash = await this.password.hash(dto.password);

    try {
      const member = await this.prisma.user.create({
        data: {
          workspaceId,
          email: dto.email.toLowerCase(),
          passwordHash,
          role: dto.role,
        },
        select: {
          id: true,
          email: true,
          role: true,
          oauthProvider: true,
          createdAt: true,
        },
      });
      this.logger.log(
        `Member ${member.id} added to workspace ${workspaceId} as ${dto.role}`,
      );
      return member;
    } catch (err) {
      // Emails are unique across the whole system, so a clash may be with an
      // account in someone else's workspace. Saying which would leak that.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }
  }

  /**
   * Changes a member's role, refusing to remove the workspace's last admin —
   * nobody would then be able to add members, change roles, or manage billing,
   * and the workspace would be permanently stuck.
   */
  async updateMemberRole(
    workspaceId: string,
    memberId: string,
    role: Role,
  ): Promise<WorkspaceMember> {
    // Scoped find, so an admin cannot reach into another workspace by id.
    const member = await this.prisma.user.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true, role: true },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === Role.admin && role !== Role.admin) {
      const admins = await this.prisma.user.count({
        where: { workspaceId, role: Role.admin },
      });
      if (admins <= 1) {
        throw new BadRequestException(
          'A workspace must keep at least one admin',
        );
      }
    }

    return this.prisma.user.update({
      where: { id: memberId },
      data: { role },
      select: {
        id: true,
        email: true,
        role: true,
        oauthProvider: true,
        createdAt: true,
      },
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
}
