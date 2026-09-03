import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Plan, Prisma, Role } from '@prisma/client';

// @nestjs/config is ESM only and reaches this spec through PasswordService.
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../../auth/services/password.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  let prisma: any;
  let password: PasswordService;
  let service: WorkspacesService;

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn() },
      user: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    };
    // 4 rounds keeps the suite fast; production reads 12 from config.
    password = new PasswordService({ get: () => '4' } as unknown as ConfigService);
    service = new WorkspacesService(prisma as PrismaService, password);
  });

  describe('summary', () => {
    it('returns the workspace with its member count', async () => {
      const createdAt = new Date();
      prisma.workspace.findUnique.mockResolvedValue({
        id: 'ws_1',
        name: 'Acme Legal',
        plan: Plan.pro,
        createdAt,
        _count: { users: 3 },
      });

      await expect(service.summary('ws_1')).resolves.toEqual({
        id: 'ws_1',
        name: 'Acme Legal',
        plan: Plan.pro,
        createdAt,
        memberCount: 3,
      });
    });

    it('404s for a workspace that does not exist', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(service.summary('ws_missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listMembers', () => {
    it('never selects the password hash', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.listMembers('ws_1');

      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ workspaceId: 'ws_1' });
      expect(args.select).not.toHaveProperty('passwordHash');
      expect(args.select).toEqual(
        expect.objectContaining({ id: true, email: true, role: true }),
      );
    });
  });

  describe('createMember', () => {
    const member = {
      id: 'u_2',
      email: 'reviewer@acme.com',
      role: Role.legal,
      oauthProvider: null,
      createdAt: new Date(),
    };

    it('creates a teammate with the requested role, in the caller workspace', async () => {
      prisma.user.create.mockResolvedValue(member);

      const created = await service.createMember('ws_1', {
        email: 'Reviewer@Acme.com',
        password: 'a-good-password',
        role: Role.legal,
      });

      const args = prisma.user.create.mock.calls[0][0];
      expect(args.data).toEqual(
        expect.objectContaining({
          workspaceId: 'ws_1',
          email: 'reviewer@acme.com',
          role: Role.legal,
        }),
      );
      expect(created).toEqual(member);
    });

    it('makes the legal and viewer roles reachable at all', async () => {
      // Before this method existed, signup hardcoded Role.admin everywhere, so
      // the @Roles checks on uploads and billing guarded against users that
      // could never be created.
      for (const role of [Role.legal, Role.viewer, Role.admin]) {
        prisma.user.create.mockResolvedValue({ ...member, role });
        const created = await service.createMember('ws_1', {
          email: `${role}@acme.com`,
          password: 'a-good-password',
          role,
        });
        expect(created.role).toBe(role);
      }
    });

    it('hashes the initial password rather than storing it', async () => {
      prisma.user.create.mockResolvedValue(member);

      await service.createMember('ws_1', {
        email: 'reviewer@acme.com',
        password: 'a-good-password',
        role: Role.viewer,
      });

      const stored = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(stored).not.toBe('a-good-password');
      await expect(password.compare('a-good-password', stored)).resolves.toBe(true);
    });

    it('never selects the password hash back out', async () => {
      prisma.user.create.mockResolvedValue(member);

      await service.createMember('ws_1', {
        email: 'reviewer@acme.com',
        password: 'a-good-password',
        role: Role.viewer,
      });

      expect(prisma.user.create.mock.calls[0][0].select).not.toHaveProperty(
        'passwordHash',
      );
    });

    it('turns a duplicate email into a 409', async () => {
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.createMember('ws_1', {
          email: 'taken@acme.com',
          password: 'a-good-password',
          role: Role.legal,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updateMemberRole', () => {
    it('looks the member up inside the caller workspace only', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_2', role: Role.viewer });
      prisma.user.update.mockResolvedValue({ id: 'u_2', role: Role.legal });

      await service.updateMemberRole('ws_1', 'u_2', Role.legal);

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'u_2',
        workspaceId: 'ws_1',
      });
    });

    it('404s for a member of another workspace', async () => {
      // The scoped lookup finds nothing, so an admin cannot reach across.
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.updateMemberRole('ws_1', 'u_elsewhere', Role.admin),
      ).rejects.toThrow(NotFoundException);
    });

    it('promotes a viewer without counting admins', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_2', role: Role.viewer });
      prisma.user.update.mockResolvedValue({ id: 'u_2', role: Role.admin });

      await service.updateMemberRole('ws_1', 'u_2', Role.admin);

      expect(prisma.user.count).not.toHaveBeenCalled();
    });

    it('refuses to demote the last admin', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_1', role: Role.admin });
      prisma.user.count.mockResolvedValue(1);

      // Otherwise the workspace would be left with nobody able to add members,
      // change roles, or manage billing — permanently stuck.
      await expect(
        service.updateMemberRole('ws_1', 'u_1', Role.viewer),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('allows demoting an admin while another one remains', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_1', role: Role.admin });
      prisma.user.count.mockResolvedValue(2);
      prisma.user.update.mockResolvedValue({ id: 'u_1', role: Role.legal });

      await expect(
        service.updateMemberRole('ws_1', 'u_1', Role.legal),
      ).resolves.toEqual({ id: 'u_1', role: Role.legal });
    });
  });

  describe('isMember', () => {
    it('matches on user and workspace together, not either alone', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_1' });

      await expect(service.isMember('u_1', 'ws_1')).resolves.toBe(true);
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'u_1',
        workspaceId: 'ws_1',
      });
    });

    it('is false for a user outside the workspace', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.isMember('u_1', 'ws_other')).resolves.toBe(false);
    });
  });
});
