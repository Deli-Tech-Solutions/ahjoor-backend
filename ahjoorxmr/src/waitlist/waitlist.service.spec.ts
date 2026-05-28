import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WaitlistService } from '../waitlist.service';
import { GroupWaitlist, WaitlistStatus } from '../entities/group-waitlist.entity';
import { Group } from '../../groups/entities/group.entity';
import { Membership } from '../../memberships/entities/membership.entity';
import { MembershipStatus } from '../../memberships/entities/membership-status.enum';
import { NotificationsService } from '../../notification/notifications.service';
import { WinstonLogger } from '../../common/logger/winston.logger';
import { NotificationType } from '../../notification/notification-type.enum';

const GROUP_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WALLET     = 'GUSER_WALLET';
const ADMIN_WALLET = 'GADMIN';

const mockGroup = (overrides: Partial<Group> = {}): Group =>
  ({ id: GROUP_ID, name: 'Test Group', maxMembers: 3, adminWallet: ADMIN_WALLET, ...overrides } as Group);

const mockEntry = (overrides: Partial<GroupWaitlist> = {}): GroupWaitlist =>
  ({
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    groupId: GROUP_ID,
    userId: USER_ID,
    walletAddress: WALLET,
    position: 1,
    status: WaitlistStatus.WAITING,
    joinedWaitlistAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GroupWaitlist);

const mockMembership = (overrides: Partial<Membership> = {}): Membership =>
  ({
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    groupId: GROUP_ID,
    userId: ADMIN_ID,
    walletAddress: ADMIN_WALLET,
    payoutOrder: 0,
    status: MembershipStatus.ACTIVE,
    hasReceivedPayout: false,
    hasPaidCurrentRound: false,
    transactionHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Membership);

describe('WaitlistService', () => {
  let service: WaitlistService;
  let waitlistRepo: Record<string, jest.Mock>;
  let groupRepo: Record<string, jest.Mock>;
  let membershipRepo: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock };
  let notificationsService: { notify: jest.Mock };

  beforeEach(async () => {
    waitlistRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    groupRepo = { findOne: jest.fn() };
    membershipRepo = { findOne: jest.fn(), count: jest.fn() };
    notificationsService = { notify: jest.fn().mockResolvedValue(null) };
    dataSource = { transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WaitlistService,
        { provide: getRepositoryToken(GroupWaitlist), useValue: waitlistRepo },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(Membership), useValue: membershipRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: WinstonLogger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(50) } },
      ],
    }).compile();

    service = module.get(WaitlistService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── joinWaitlist ──────────────────────────────────────────────────────────

  describe('joinWaitlist', () => {
    it('returns position and stores walletAddress when group is full', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(null);
      membershipRepo.count.mockResolvedValue(3);
      waitlistRepo.count.mockResolvedValue(2);
      waitlistRepo.create.mockReturnValue(mockEntry({ position: 3 }));
      waitlistRepo.save.mockResolvedValue(mockEntry({ position: 3 }));

      const result = await service.joinWaitlist(GROUP_ID, USER_ID, WALLET);

      expect(result.position).toBe(3);
      expect(waitlistRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: WALLET }),
      );
    });

    it('throws ConflictException when user is already a member', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(mockMembership({ userId: USER_ID }));

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when user is already on the waitlist', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(mockEntry());

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when group is not full', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup({ maxMembers: 5 }));
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(null);
      membershipRepo.count.mockResolvedValue(3);

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(BadRequestException);
    });

    it('enforces waitlist cap with clear error message', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(null);
      membershipRepo.count.mockResolvedValue(3);
      waitlistRepo.count.mockResolvedValue(50);

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(
        'Waitlist is full (max 50 users)',
      );
    });

    it('throws NotFoundException when group does not exist', async () => {
      groupRepo.findOne.mockResolvedValue(null);
      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── leaveWaitlist ─────────────────────────────────────────────────────────

  describe('leaveWaitlist', () => {
    it('cancels entry and re-sequences positions behind it', async () => {
      const entry = mockEntry({ position: 2 });
      waitlistRepo.findOne.mockResolvedValue(entry);
      waitlistRepo.save.mockResolvedValue({ ...entry, status: WaitlistStatus.CANCELLED });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      waitlistRepo.createQueryBuilder.mockReturnValue(qb);

      await service.leaveWaitlist(GROUP_ID, USER_ID);

      expect(waitlistRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: WaitlistStatus.CANCELLED }),
      );
      // Re-sequencing UPDATE was called
      expect(qb.execute).toHaveBeenCalled();
    });

    it('positions remain contiguous after cancellation (re-sequence called with correct params)', async () => {
      const entry = mockEntry({ position: 1 });
      waitlistRepo.findOne.mockResolvedValue(entry);
      waitlistRepo.save.mockResolvedValue({ ...entry, status: WaitlistStatus.CANCELLED });

      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      };
      waitlistRepo.createQueryBuilder.mockReturnValue(qb);

      await service.leaveWaitlist(GROUP_ID, USER_ID);

      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining('position > :pos'),
        expect.objectContaining({ pos: 1, status: WaitlistStatus.WAITING }),
      );
    });

    it('throws NotFoundException when entry does not exist', async () => {
      waitlistRepo.findOne.mockResolvedValue(null);
      await expect(service.leaveWaitlist(GROUP_ID, USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getMyPosition ─────────────────────────────────────────────────────────

  describe('getMyPosition', () => {
    it('returns position and status for a waiting user', async () => {
      waitlistRepo.findOne.mockResolvedValue(mockEntry({ position: 3, status: WaitlistStatus.WAITING }));

      const result = await service.getMyPosition(GROUP_ID, USER_ID);

      expect(result.position).toBe(3);
      expect(result.status).toBe(WaitlistStatus.WAITING);
    });

    it('throws NotFoundException when user has no entry', async () => {
      waitlistRepo.findOne.mockResolvedValue(null);
      await expect(service.getMyPosition(GROUP_ID, USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getWaitlist ───────────────────────────────────────────────────────────

  describe('getWaitlist', () => {
    it('returns ordered waitlist for group admin', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(mockMembership({ userId: ADMIN_ID, walletAddress: ADMIN_WALLET }));
      waitlistRepo.find.mockResolvedValue([mockEntry({ position: 1 }), mockEntry({ position: 2 })]);

      const result = await service.getWaitlist(GROUP_ID, ADMIN_ID);
      expect(result).toHaveLength(2);
    });

    it('throws ForbiddenException for non-admin member', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(mockMembership({ walletAddress: 'GOTHER' }));

      await expect(service.getWaitlist(GROUP_ID, ADMIN_ID)).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for non-member', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);

      await expect(service.getWaitlist(GROUP_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── admitNextFromWaitlist ─────────────────────────────────────────────────

  describe('admitNextFromWaitlist', () => {
    const buildManager = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ maxOrder: 1 }),
      }),
      ...overrides,
    });

    it('creates membership with stored walletAddress and marks entry ADMITTED', async () => {
      const entry = mockEntry({ position: 1, walletAddress: WALLET });
      const group = mockGroup();
      const manager = buildManager({
        findOne: jest.fn()
          .mockResolvedValueOnce(entry)
          .mockResolvedValueOnce(group),
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn().mockReturnValue(mockMembership({ userId: USER_ID, walletAddress: WALLET })),
        save: jest.fn().mockResolvedValue({}),
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);

      expect(manager.create).toHaveBeenCalledWith(
        Membership,
        expect.objectContaining({ walletAddress: WALLET, userId: USER_ID, status: MembershipStatus.ACTIVE }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        GroupWaitlist,
        expect.objectContaining({ status: WaitlistStatus.ADMITTED }),
      );
    });

    it('admission is atomic: both membership insert and waitlist update in one transaction', async () => {
      const entry = mockEntry({ position: 1 });
      const group = mockGroup();
      const saveCalls: any[] = [];
      const manager = buildManager({
        findOne: jest.fn()
          .mockResolvedValueOnce(entry)
          .mockResolvedValueOnce(group),
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn().mockReturnValue(mockMembership({ userId: USER_ID })),
        save: jest.fn().mockImplementation((entity, data) => {
          saveCalls.push({ entity, data });
          return Promise.resolve(data);
        }),
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);

      // Both saves happened inside the same transaction callback
      expect(saveCalls).toHaveLength(2);
      expect(saveCalls[0].entity).toBe(Membership);
      expect(saveCalls[1].entity).toBe(GroupWaitlist);
    });

    it('does nothing when no WAITING entry exists', async () => {
      const manager = buildManager({ findOne: jest.fn().mockResolvedValue(null) });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('does nothing when group is still at capacity (race condition guard)', async () => {
      const entry = mockEntry();
      const group = mockGroup({ maxMembers: 3 });
      const manager = buildManager({
        findOne: jest.fn()
          .mockResolvedValueOnce(entry)
          .mockResolvedValueOnce(group),
        count: jest.fn().mockResolvedValue(3),
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('sends WAITLIST_ADMITTED notification after admission', async () => {
      jest.useFakeTimers();
      const entry = mockEntry({ position: 1 });
      const group = mockGroup();
      const manager = buildManager({
        findOne: jest.fn()
          .mockResolvedValueOnce(entry)
          .mockResolvedValueOnce(group),
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn().mockReturnValue(mockMembership({ userId: USER_ID })),
        save: jest.fn().mockResolvedValue({}),
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      jest.runAllImmediates();

      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          type: NotificationType.WAITLIST_ADMITTED,
        }),
      );
      jest.useRealTimers();
    });
  });
});
