import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MembershipsService } from '../memberships.service';
import { Membership } from '../entities/membership.entity';
import { Group } from '../../groups/entities/group.entity';
import { WinstonLogger } from '../../common/logger/winston.logger';
import { MembershipStatus } from '../entities/membership-status.enum';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { NotificationsService } from '../../notification/notifications.service';
import { GroupStatus } from '../../groups/entities/group-status.enum';
import { WaitlistService } from '../../waitlist/waitlist.service';
import { MemberTrustScore } from '../../trust-score/entities/member-trust-score.entity';

/**
 * Mock factory for creating Membership entities with default values.
 * Allows partial overrides for specific test scenarios.
 */
const createMockMembership = (overrides?: Partial<Membership>): Membership => {
  const defaultMembership: Membership = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    groupId: '123e4567-e89b-12d3-a456-426614174001',
    userId: '123e4567-e89b-12d3-a456-426614174002',
    walletAddress: '0x1234567890abcdef',
    payoutOrder: 0,
    hasReceivedPayout: false,
    hasPaidCurrentRound: false,
    transactionHash: null,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    group: null,
    user: null,
  };

  return { ...defaultMembership, ...overrides };
};

/**
 * Mock factory for creating Group entities with default values.
 * Allows partial overrides for specific test scenarios.
 */
const createMockGroup = (overrides?: Partial<Group>): Group => {
  const defaultGroup: Group = {
    id: '123e4567-e89b-12d3-a456-426614174001',
    name: 'Test Group',
    contributionAmount: '100',
    status: GroupStatus.PENDING,
    totalRounds: 5,
    maxMembers: 5,
    currentRound: 1,
  };

  return { ...defaultGroup, ...overrides } as Group;
};

/**
 * Type definition for mocked TypeORM repository.
 * Includes all commonly used repository methods.
 */
type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;

/**
 * Creates a mock repository with Jest mock functions for all methods.
 */
const createMockRepository = <T = any>(): MockRepository<T> => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
  count: jest.fn(),
  createQueryBuilder: jest.fn(),
});

/**
 * Type definition for mocked WinstonLogger.
 */
type MockLogger = Partial<Record<keyof WinstonLogger, jest.Mock>>;

/**
 * Creates a mock logger with Jest mock functions for all methods.
 */
const createMockLogger = (): MockLogger => ({
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
});

describe('MembershipsService', () => {
  let service: MembershipsService;
  let membershipRepository: MockRepository<Membership>;
  let groupRepository: MockRepository<Group>;
  let logger: MockLogger;
  let notificationsService: Partial<NotificationsService>;
  let txManager: {
    createQueryBuilder: jest.Mock;
    count: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    // Create mock instances
    membershipRepository = createMockRepository<Membership>();
    groupRepository = createMockRepository<Group>();
    logger = createMockLogger();
    notificationsService = {
      notify: jest.fn().mockResolvedValue({}),
    };

    txManager = {
      createQueryBuilder: jest.fn().mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getOne: jest
          .fn()
          .mockResolvedValue(
            createMockGroup({ status: GroupStatus.PENDING, maxMembers: 5 }),
          ),
        getRawOne: jest.fn().mockResolvedValue({ maxOrder: 0 }),
      }),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((_e, data) => data),
      save: jest
        .fn()
        .mockImplementation((_e, data) => Promise.resolve(createMockMembership(data))),
    };
    dataSource = {
      transaction: jest.fn(async (cb) => cb(txManager)),
    };

    // Create testing module with mocked dependencies
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipsService,
        {
          provide: getRepositoryToken(Membership),
          useValue: membershipRepository,
        },
        {
          provide: getRepositoryToken(Group),
          useValue: groupRepository,
        },
        {
          provide: WinstonLogger,
          useValue: logger,
        },
        {
          provide: NotificationsService,
          useValue: notificationsService,
        },
        {
          provide: WaitlistService,
          useValue: { admitFromWaitlist: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(MemberTrustScore),
          useValue: createMockRepository(),
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<MembershipsService>(MembershipsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Service Initialization', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have membershipRepository injected', () => {
      expect(membershipRepository).toBeDefined();
    });

    it('should have groupRepository injected', () => {
      expect(groupRepository).toBeDefined();
    });

    it('should have logger injected', () => {
      expect(logger).toBeDefined();
    });
  });

  describe('Mock Factories', () => {
    it('should create a mock membership with default values', () => {
      const membership = createMockMembership();

      expect(membership.id).toBeDefined();
      expect(membership.groupId).toBeDefined();
      expect(membership.userId).toBeDefined();
      expect(membership.walletAddress).toBeDefined();
      expect(membership.payoutOrder).toBe(0);
      expect(membership.hasReceivedPayout).toBe(false);
      expect(membership.hasPaidCurrentRound).toBe(false);
      expect(membership.status).toBe(MembershipStatus.ACTIVE);
      expect(membership.createdAt).toBeInstanceOf(Date);
      expect(membership.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a mock membership with overrides', () => {
      const membership = createMockMembership({
        payoutOrder: 5,
        status: MembershipStatus.SUSPENDED,
        hasReceivedPayout: true,
      });

      expect(membership.payoutOrder).toBe(5);
      expect(membership.status).toBe(MembershipStatus.SUSPENDED);
      expect(membership.hasReceivedPayout).toBe(true);
      expect(membership.hasPaidCurrentRound).toBe(false); // Default value preserved
    });

    it('should create a mock group with default values', () => {
      const group = createMockGroup();

      expect(group.id).toBeDefined();
      expect(group.status).toBe('PENDING');
    });

    it('should create a mock group with overrides', () => {
      const group = createMockGroup({ status: 'ACTIVE' });

      expect(group.status).toBe(GroupStatus.ACTIVE);
    });
  });

  describe('recordPayout', () => {
    const groupId = '123e4567-e89b-12d3-a456-426614174001';
    const userId = '123e4567-e89b-12d3-a456-426614174002';
    const txHash = '0xabcdef1234567890';

    it('should record payout successfully when payoutOrder matches currentRound - 1', async () => {
      // currentRound=1, so expectedPayoutOrder=0; membership.payoutOrder=0 → correct
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 1,
      });
      const membership = createMockMembership({
        hasReceivedPayout: false,
        payoutOrder: 0,
      });
      const updatedMembership = {
        ...membership,
        hasReceivedPayout: true,
        transactionHash: txHash,
      };

      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(membership);
      membershipRepository.save!.mockResolvedValue(updatedMembership);

      const result = await service.recordPayout(groupId, userId, txHash);

      expect(result.hasReceivedPayout).toBe(true);
      expect(result.transactionHash).toBe(txHash);
      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          type: 'payout_received',
          title: 'Payout Received',
        }),
      );
    });

    it('should throw BadRequestException when payoutOrder is ahead of current round (out-of-order)', async () => {
      // currentRound=1, expectedPayoutOrder=0; membership.payoutOrder=2 → out-of-order
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 1,
      });
      const membership = createMockMembership({
        hasReceivedPayout: false,
        payoutOrder: 2,
      });

      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(membership);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow('Payout order mismatch');
    });

    it('should throw BadRequestException when a round is skipped (member payoutOrder behind current round)', async () => {
      // currentRound=3, expectedPayoutOrder=2; membership.payoutOrder=0 → skipped rounds
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 3,
      });
      const membership = createMockMembership({
        hasReceivedPayout: false,
        payoutOrder: 0,
      });

      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(membership);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow('Payout order mismatch');
    });

    it('should throw NotFoundException when group does not exist', async () => {
      groupRepository.findOne!.mockResolvedValue(null);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when group is not ACTIVE', async () => {
      const group = createMockGroup({ status: GroupStatus.PENDING });
      groupRepository.findOne!.mockResolvedValue(group);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when membership does not exist', async () => {
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 1,
      });
      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(null);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when member already received payout', async () => {
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 1,
      });
      const membership = createMockMembership({
        hasReceivedPayout: true,
        payoutOrder: 0,
      });

      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(membership);

      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.recordPayout(groupId, userId, txHash),
      ).rejects.toThrow('Member has already received payout');
    });
  });

  describe('getCurrentRecipient', () => {
    const groupId = '123e4567-e89b-12d3-a456-426614174001';

    it('should return the membership scheduled for the current round', async () => {
      // currentRound=2, so expectedPayoutOrder=1
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 2,
      });
      const membership = createMockMembership({ payoutOrder: 1 });

      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(membership);

      const result = await service.getCurrentRecipient(groupId);

      expect(result.payoutOrder).toBe(1);
      expect(membershipRepository.findOne).toHaveBeenCalledWith({
        where: { groupId, payoutOrder: 1 },
      });
    });

    it('should throw NotFoundException when group does not exist', async () => {
      groupRepository.findOne!.mockResolvedValue(null);

      await expect(service.getCurrentRecipient(groupId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when group is not ACTIVE', async () => {
      const group = createMockGroup({ status: GroupStatus.PENDING });
      groupRepository.findOne!.mockResolvedValue(group);

      await expect(service.getCurrentRecipient(groupId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when no member is scheduled for the current round', async () => {
      const group = createMockGroup({
        status: GroupStatus.ACTIVE,
        currentRound: 1,
      });
      groupRepository.findOne!.mockResolvedValue(group);
      membershipRepository.findOne!.mockResolvedValue(null);

      await expect(service.getCurrentRecipient(groupId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getCurrentRecipient(groupId)).rejects.toThrow(
        'No member scheduled for payout in round 1',
      );
    });
  });

  // Placeholder for addMember tests
  describe('addMember', () => {
    const groupId = '123e4567-e89b-12d3-a456-426614174001';
    const dto = {
      userId: '123e4567-e89b-12d3-a456-426614174002',
      walletAddress: '0xabc',
    };

    const stubGroupLock = (group: Group, memberCount: number) => {
      const qb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(group),
        getRawOne: jest.fn().mockResolvedValue({ maxOrder: memberCount - 1 }),
      };
      txManager.createQueryBuilder.mockReturnValue(qb);
      txManager.count.mockResolvedValue(memberCount);
      txManager.findOne.mockResolvedValue(null);
      return qb;
    };

    it('should be defined', () => {
      expect(service.addMember).toBeDefined();
    });

    it('should throw BadRequestException when group is at maxMembers cap', async () => {
      const group = createMockGroup({ maxMembers: 3, status: GroupStatus.PENDING });
      stubGroupLock(group, 3);

      await expect(service.addMember(groupId, dto)).rejects.toThrow(BadRequestException);
      await expect(service.addMember(groupId, dto)).rejects.toThrow(
        'maximum member capacity of 3',
      );
    });

    it('should throw BadRequestException when group exceeds maxMembers cap', async () => {
      const group = createMockGroup({ maxMembers: 3, status: GroupStatus.PENDING });
      stubGroupLock(group, 4);

      await expect(service.addMember(groupId, dto)).rejects.toThrow(BadRequestException);
    });

    it('should lock the group row when checking capacity', async () => {
      const group = createMockGroup({ maxMembers: 3, status: GroupStatus.PENDING });
      const qb = stubGroupLock(group, 2);
      const membership = createMockMembership();
      txManager.create.mockReturnValue(membership);
      txManager.save.mockResolvedValue(membership);

      await service.addMember(groupId, dto);

      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('should add member successfully when below maxMembers cap', async () => {
      const group = createMockGroup({ maxMembers: 3, status: GroupStatus.PENDING });
      stubGroupLock(group, 2);
      const membership = createMockMembership();
      txManager.create.mockReturnValue(membership);
      txManager.save.mockResolvedValue(membership);

      const result = await service.addMember(groupId, dto);

      expect(result).toEqual(membership);
    });

    it('should add member successfully when exactly one below cap (boundary)', async () => {
      const group = createMockGroup({ maxMembers: 5, status: GroupStatus.PENDING });
      stubGroupLock(group, 4);
      const membership = createMockMembership();
      txManager.create.mockReturnValue(membership);
      txManager.save.mockResolvedValue(membership);

      const result = await service.addMember(groupId, dto);

      expect(result).toEqual(membership);
    });
  });

  // Placeholder for removeMember tests
  describe('removeMember', () => {
    it('should be defined', () => {
      expect(service.removeMember).toBeDefined();
    });
  });

  // Placeholder for listMembers tests
  describe('listMembers', () => {
    it('should be defined', () => {
      expect(service.listMembers).toBeDefined();
    });
  });
});
