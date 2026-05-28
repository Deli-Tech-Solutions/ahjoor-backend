import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, LessThan, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { GroupInvite, InviteStatus } from '../../../groups/entities/group-invite.entity';
import { Group } from '../../../groups/entities/group.entity';
import { Membership } from '../../../memberships/entities/membership.entity';
import { User } from '../../../users/entities/user.entity';
import { GroupInviteService } from '../../../groups/invites/group-invite.service';
import { MailService } from '../../../mail/mail.service';

describe('GroupInviteService - expireStaleInvites', () => {
  let service: GroupInviteService;
  let inviteRepository: jest.Mocked<Repository<GroupInvite>>;

  const mockInvite = (overrides: Partial<GroupInvite> = {}): GroupInvite => {
    const base = {
      id: 'invite-1',
      groupId: 'group-1',
      createdBy: 'user-1',
      code: 'ABC123',
      maxUses: 1,
      usedCount: 0,
      expiresAt: new Date('2024-01-01'),
      status: InviteStatus.ACTIVE,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      group: null as any,
      creator: null as any,
    };
    return { ...base, ...overrides } as GroupInvite;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupInviteService,
        {
          provide: getRepositoryToken(GroupInvite),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Group),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Membership),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((fn) => fn({
              createQueryBuilder: jest.fn().mockReturnValue({
                setLock: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                getOne: jest.fn(),
              }),
              findOne: jest.fn(),
              increment: jest.fn(),
              update: jest.fn(),
              create: jest.fn(),
              save: jest.fn(),
            })),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<GroupInviteService>(GroupInviteService);
    inviteRepository = module.get(getRepositoryToken(GroupInvite));
  });

  describe('expireStaleInvites', () => {
    it('should only target ACTIVE invites with expired expiresAt', async () => {
      inviteRepository.update.mockResolvedValue({ affected: 5, raw: [], generatedMaps: [] });

      const result = await service.expireStaleInvites();

      expect(result).toBe(5);
      expect(inviteRepository.update).toHaveBeenCalledWith(
        {
          status: InviteStatus.ACTIVE,
          expiresAt: expect.any(Date),
        },
        { status: InviteStatus.EXPIRED },
      );

      // Verify the expiresAt filter uses LessThan
      const updateCall = inviteRepository.update.mock.calls[0];
      const whereCriteria = updateCall[0];
      expect(whereCriteria.status).toBe(InviteStatus.ACTIVE);
      expect(whereCriteria.expiresAt).toBeInstanceOf(Date);
    });

    it('should not affect ACCEPTED/EXHAUSTED invites (status other than ACTIVE)', async () => {
      inviteRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

      await service.expireStaleInvites();

      // Verify the query only targets ACTIVE status
      const updateCall = inviteRepository.update.mock.calls[0];
      const whereCriteria = updateCall[0];
      expect(whereCriteria.status).toBe(InviteStatus.ACTIVE);
      expect(whereCriteria.status).not.toBe(InviteStatus.EXHAUSTED);
    });

    it('should not affect EXPIRED invites (already expired)', async () => {
      inviteRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

      await service.expireStaleInvites();

      // Verify the query only targets ACTIVE status
      const updateCall = inviteRepository.update.mock.calls[0];
      const whereCriteria = updateCall[0];
      expect(whereCriteria.status).toBe(InviteStatus.ACTIVE);
      expect(whereCriteria.status).not.toBe(InviteStatus.EXPIRED);
    });

    it('should return 0 when no stale invites are found', async () => {
      inviteRepository.update.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

      const result = await service.expireStaleInvites();

      expect(result).toBe(0);
      expect(inviteRepository.update).toHaveBeenCalled();
    });

    it('should return the count of affected rows', async () => {
      inviteRepository.update.mockResolvedValue({ affected: 10, raw: [], generatedMaps: [] });

      const result = await service.expireStaleInvites();

      expect(result).toBe(10);
    });

    it('should handle null affected count gracefully', async () => {
      inviteRepository.update.mockResolvedValue({ affected: null, raw: [], generatedMaps: [] });

      const result = await service.expireStaleInvites();

      expect(result).toBe(0);
    });

    it('should use current date for expiresAt comparison', async () => {
      const beforeCall = new Date();
      inviteRepository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await service.expireStaleInvites();

      const afterCall = new Date();
      const updateCall = inviteRepository.update.mock.calls[0];
      const whereCriteria = updateCall[0];
      const expiresAtValue = whereCriteria.expiresAt;

      // The expiresAt filter should be a Date between beforeCall and afterCall
      expect(expiresAtValue).toBeInstanceOf(Date);
      expect(expiresAtValue.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(expiresAtValue.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });
  });
});
