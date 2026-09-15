import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Plan, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleInvalidationStore } from '../../auth/services/role-invalidation.store';
import { WorkspacesService } from './workspaces.service';

// @nestjs/config v12 ships ESM only, which Jest's CommonJS runtime cannot parse.
jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));

describe('WorkspacesService', () => {
  let prisma: any;
  let service: WorkspacesService;

  const config = {
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;

  const roleInvalidations = {
    invalidate: jest.fn().mockResolvedValue(undefined),
  } as unknown as RoleInvalidationStore;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      workspace: { findUnique: jest.fn() },
      user: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new WorkspacesService(
      prisma as PrismaService,
      config,
      roleInvalidations,
    );
  });

  describe('createInvite', () => {
    it('creates a single-use code with the requested role and expiry', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws_1' });
      prisma.invitation = { create: jest.fn() };

      prisma.invitation.create.mockResolvedValue({
        id: 'inv_1',
        workspaceId: 'ws_1',
        code: 'A1B2C3D4E5F6',
        role: Role.legal,
        expiresAt: '2026-09-14T00:00:00.000Z',
        createdAt: '2026-09-07T00:00:00.000Z',
      });

      const result = await service.createInvite('ws_1', 'u_admin', {
        role: Role.legal,
        expiresInDays: 7,
      });

      expect(prisma.invitation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws_1',
          createdByUserId: 'u_admin',
          role: Role.legal,
        }),
      });
      // Code is derived from 6 random bytes => 12 upper-case hex chars.
      expect(result.code).toMatch(/^[0-9A-F]{12}$/);
      expect(result.role).toBe(Role.legal);
      expect(result.expiresAt).toBe('2026-09-14T00:00:00.000Z');
    });

    it('404s when the workspace is unknown', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);

      await expect(
        service.createInvite('ws_missing', 'u_admin', {
          role: Role.viewer,
          expiresInDays: 7,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.invitation).toBeUndefined();
    });
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

    it('scopes the query to the given workspace', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'u_1', email: 'a@acme.com', role: Role.admin, oauthProvider: null, createdAt: new Date() },
      ]);

      const members = await service.listMembers('ws_1');

      expect(members).toHaveLength(1);
      expect(prisma.user.findMany.mock.calls[0][0].where.workspaceId).toBe('ws_1');
    });
  });

  describe('updateRole', () => {
    it('scopes the member lookup to the caller workspace and flags the change', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u_1' });
      prisma.user.update.mockResolvedValue({
        id: 'u_1',
        email: 'a@acme.com',
        role: Role.legal,
        oauthProvider: null,
        createdAt: new Date(),
      });

      const out = await service.updateRole('ws_1', 'u_1', Role.legal);

      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({
        id: 'u_1',
        workspaceId: 'ws_1',
      });
      expect(roleInvalidations.invalidate).toHaveBeenCalledWith(
        'u_1',
        expect.any(Number),
      );
      expect(out.role).toBe(Role.legal);
    });

    it('404s and never flags a user outside the workspace', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.updateRole('ws_1', 'u_other', Role.legal),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(roleInvalidations.invalidate).not.toHaveBeenCalled();
    });
  });
});
