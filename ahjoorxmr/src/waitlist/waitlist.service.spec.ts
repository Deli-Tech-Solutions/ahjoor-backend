import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WaitlistService } from './waitlist.service';
import { GroupWaitlist, WaitlistStatus } from './entities/group-waitlist.entity';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { MembershipStatus } from '../memberships/entities/membership-status.enum';
import { NotificationsService } from '../notification/notifications.service';
import { WinstonLogger } from '../common/logger/winston.logger';
import { NotificationType } from '../notification/notification-type.enum';

const GROUP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WALLET = 'GUSER_WALLET';
const ADMIN_WALLET = 'GADMIN';

const mockGroup = (overrides: Partial<Group> = {}): Group =>
  ({
    id: GROUP_ID,
    name: 'Test Group',
    maxMembers: 3,
    adminWallet: ADMIN_WALLET,
    ...overrides,
  }) as Group;

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
  }) as GroupWaitlist;

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
  }) as Membership;

/** Builds a QB chain that can serve group lock, waitlist lock, or MAX(payoutOrder). */
function buildAdmitQueryBuilder(opts: {
  group: Group | null;
  waitlist: GroupWaitlist[];
  maxOrder?: number | null;
}) {
  const chain: Record<string, jest.Mock> = {};
  chain.setLock = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.take = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.getOne = jest.fn().mockResolvedValue(opts.group);
  chain.getMany = jest.fn().mockResolvedValue(opts.waitlist);
  chain.getRawOne = jest.fn().mockResolvedValue({ maxOrder: opts.maxOrder ?? 1 });
  return chain;
}

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
        {
          provide: WinstonLogger,
          useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(50) } },
      ],
    }).compile();

    service = module.get(WaitlistService);
  });

  afterEach(() => jest.clearAllMocks());

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

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ConflictException when user is already on the waitlist', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(mockEntry());

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws BadRequestException when group is not full', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup({ maxMembers: 5 }));
      membershipRepo.findOne.mockResolvedValue(null);
      waitlistRepo.findOne.mockResolvedValue(null);
      membershipRepo.count.mockResolvedValue(3);

      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(
        BadRequestException,
      );
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
      await expect(service.joinWaitlist(GROUP_ID, USER_ID, WALLET)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

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
      await expect(service.leaveWaitlist(GROUP_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getMyPosition', () => {
    it('returns position and status for a waiting user', async () => {
      waitlistRepo.findOne.mockResolvedValue(
        mockEntry({ position: 3, status: WaitlistStatus.WAITING }),
      );

      const result = await service.getMyPosition(GROUP_ID, USER_ID);

      expect(result.position).toBe(3);
      expect(result.status).toBe(WaitlistStatus.WAITING);
    });

    it('throws NotFoundException when user has no entry', async () => {
      waitlistRepo.findOne.mockResolvedValue(null);
      await expect(service.getMyPosition(GROUP_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getWaitlist', () => {
    it('returns ordered waitlist for group admin', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(
        mockMembership({ userId: ADMIN_ID, walletAddress: ADMIN_WALLET }),
      );
      waitlistRepo.find.mockResolvedValue([
        mockEntry({ position: 1 }),
        mockEntry({ position: 2 }),
      ]);

      const result = await service.getWaitlist(GROUP_ID, ADMIN_ID);
      expect(result).toHaveLength(2);
    });

    it('throws ForbiddenException for non-admin member', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(mockMembership({ walletAddress: 'GOTHER' }));

      await expect(service.getWaitlist(GROUP_ID, ADMIN_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException for non-member', async () => {
      groupRepo.findOne.mockResolvedValue(mockGroup());
      membershipRepo.findOne.mockResolvedValue(null);

      await expect(service.getWaitlist(GROUP_ID, USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('admitFromWaitlist', () => {
    const buildManager = (opts: {
      group: Group | null;
      waitlist: GroupWaitlist[];
      memberCount: number;
      maxOrder?: number | null;
    }) => {
      let qbCalls = 0;
      return {
        count: jest.fn().mockResolvedValue(opts.memberCount),
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => Promise.resolve(data)),
        createQueryBuilder: jest.fn().mockImplementation(() => {
          qbCalls += 1;
          // 1st: lock group, 2nd: lock waitlist rows, 3rd: MAX payoutOrder
          if (qbCalls === 1) {
            return buildAdmitQueryBuilder({ group: opts.group, waitlist: [] });
          }
          if (qbCalls === 2) {
            return buildAdmitQueryBuilder({
              group: null,
              waitlist: opts.waitlist,
            });
          }
          return buildAdmitQueryBuilder({
            group: null,
            waitlist: [],
            maxOrder: opts.maxOrder ?? 1,
          });
        }),
      };
    };

    it('locks the group row then admits with stored walletAddress', async () => {
      const entry = mockEntry({ position: 1, walletAddress: WALLET });
      const group = mockGroup({ maxMembers: 3 });
      const manager = buildManager({ group, waitlist: [entry], memberCount: 2 });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);

      const groupQb = manager.createQueryBuilder.mock.results[0].value;
      expect(groupQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(manager.create).toHaveBeenCalledWith(
        Membership,
        expect.objectContaining({
          walletAddress: WALLET,
          userId: USER_ID,
          status: MembershipStatus.ACTIVE,
        }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        GroupWaitlist,
        expect.objectContaining({ status: WaitlistStatus.ADMITTED }),
      );
    });

    it('admission is atomic: membership insert and waitlist update in one transaction', async () => {
      const entry = mockEntry({ position: 1 });
      const group = mockGroup();
      const saveCalls: any[] = [];
      const manager = buildManager({ group, waitlist: [entry], memberCount: 2 });
      manager.save = jest.fn().mockImplementation((entity, data) => {
        saveCalls.push({ entity, data });
        return Promise.resolve(data);
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);

      expect(saveCalls).toHaveLength(2);
      expect(saveCalls[0].entity).toBe(Membership);
      expect(saveCalls[1].entity).toBe(GroupWaitlist);
    });

    it('does nothing when group is missing', async () => {
      const manager = buildManager({ group: null, waitlist: [], memberCount: 0 });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('does nothing when group is still at capacity', async () => {
      const entry = mockEntry();
      const group = mockGroup({ maxMembers: 3 });
      const manager = buildManager({ group, waitlist: [entry], memberCount: 3 });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('does nothing when no WAITING entry exists', async () => {
      const group = mockGroup({ maxMembers: 5 });
      const manager = buildManager({ group, waitlist: [], memberCount: 2 });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      const admitted = await service.admitFromWaitlist(GROUP_ID);
      expect(admitted).toEqual([]);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('fills multiple free slots in FIFO position order', async () => {
      const group = mockGroup({ maxMembers: 5 });
      const waitlist = [1, 2, 3, 4, 5].map((position) =>
        mockEntry({
          id: `entry-${position}`,
          userId: `user-${position}`,
          walletAddress: `G${position}`,
          position,
        }),
      );
      // 2 members → 3 free slots
      const manager = buildManager({
        group,
        waitlist: waitlist.slice(0, 3),
        memberCount: 2,
        maxOrder: 1,
      });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      const admitted = await service.admitFromWaitlist(GROUP_ID);

      expect(admitted).toEqual(['user-1', 'user-2', 'user-3']);
      expect(manager.save).toHaveBeenCalledTimes(6); // 3 memberships + 3 waitlist
    });

    it('sends WAITLIST_ADMITTED notification with idempotency key after admission', async () => {
      jest.useFakeTimers({ legacyFakeTimers: true });
      const entry = mockEntry({ position: 1, id: 'entry-1' });
      const group = mockGroup();
      const manager = buildManager({ group, waitlist: [entry], memberCount: 2 });
      dataSource.transaction.mockImplementation((cb) => cb(manager));

      await service.admitNextFromWaitlist(GROUP_ID);
      jest.runAllImmediates();

      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          type: NotificationType.WAITLIST_ADMITTED,
          idempotencyKey: `waitlist_admitted:${GROUP_ID}:${USER_ID}:entry-1`,
        }),
      );
      jest.useRealTimers();
    });
  });

  /**
   * Simulates 3 concurrent leave-triggered admits against a group with
   * maxMembers=5, 2 remaining members, and 5 waitlisted users.
   * Group-row lock is modeled as a mutex so admits serialize like FOR UPDATE.
   */
  describe('concurrent leave over-promotion guard', () => {
    it('promotes exactly 3 FIFO users when 3 admits race after 3 leaves', async () => {
      const maxMembers = 5;
      let memberCount = 2; // after 3 of 5 members left
      const waitlist = [1, 2, 3, 4, 5].map((position) => ({
        id: `wl-${position}`,
        userId: `wait-user-${position}`,
        walletAddress: `GW${position}`,
        position,
        status: WaitlistStatus.WAITING as WaitlistStatus,
        groupId: GROUP_ID,
      }));
      const admittedUserIds: string[] = [];

      let groupLock: Promise<void> = Promise.resolve();

      const runSerialized = async <T>(fn: () => Promise<T>): Promise<T> => {
        let release!: () => void;
        const next = new Promise<void>((r) => {
          release = r;
        });
        const prev = groupLock;
        groupLock = prev.then(() => next);
        await prev;
        try {
          return await fn();
        } finally {
          release();
        }
      };

      const fakeManager = {
        createQueryBuilder: jest.fn().mockImplementation((entity: unknown) => {
          const chain: Record<string, any> = {
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            take: jest.fn().mockImplementation((n: number) => {
              chain._take = n;
              return chain;
            }),
            select: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(
              mockGroup({ maxMembers, name: 'Concurrency Group' }),
            ),
            getMany: jest.fn().mockImplementation(async () => {
              const take = chain._take ?? waitlist.length;
              return waitlist
                .filter((e) => e.status === WaitlistStatus.WAITING)
                .sort((a, b) => a.position - b.position)
                .slice(0, take)
                .map((e) => ({ ...e }));
            }),
            getRawOne: jest.fn().mockResolvedValue({ maxOrder: memberCount - 1 }),
          };
          // Distinguish group vs waitlist by entity/alias usage — both use same chain;
          // getOne is for group, getMany for waitlist (matches production call order).
          void entity;
          return chain;
        }),
        count: jest.fn().mockImplementation(async () => memberCount),
        create: jest.fn().mockImplementation((_e, data) => data),
        save: jest.fn().mockImplementation(async (entity, data) => {
          if (entity === Membership) {
            memberCount += 1;
            admittedUserIds.push(data.userId);
          }
          if (entity === GroupWaitlist) {
            const row = waitlist.find((w) => w.id === data.id);
            if (row) row.status = WaitlistStatus.ADMITTED;
          }
          return data;
        }),
      } as unknown as EntityManager;

      dataSource.transaction.mockImplementation(async (cb) =>
        runSerialized(() => cb(fakeManager)),
      );

      // Three leave events each fire admitFromWaitlist (fill-all free slots)
      const results = await Promise.all([
        service.admitFromWaitlist(GROUP_ID),
        service.admitFromWaitlist(GROUP_ID),
        service.admitFromWaitlist(GROUP_ID),
      ]);

      const allAdmitted = results.flat();
      expect(allAdmitted).toHaveLength(3);
      expect(allAdmitted).toEqual([
        'wait-user-1',
        'wait-user-2',
        'wait-user-3',
      ]);
      expect(memberCount).toBe(5);
      expect(admittedUserIds).toEqual([
        'wait-user-1',
        'wait-user-2',
        'wait-user-3',
      ]);
      expect(
        waitlist.filter((w) => w.status === WaitlistStatus.WAITING).map((w) => w.userId),
      ).toEqual(['wait-user-4', 'wait-user-5']);
    });
  });
});
