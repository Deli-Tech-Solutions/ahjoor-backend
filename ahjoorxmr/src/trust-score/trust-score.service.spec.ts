import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { TrustScoreService, computeTrustScore, TrustScoreComponents } from './trust-score.service';
import { MemberTrustScore } from './entities/member-trust-score.entity';
import { Contribution, ContributionStatus } from '../contributions/entities/contribution.entity';
import { Penalty, PenaltyStatus } from '../penalties/entities/penalty.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { Group } from '../groups/entities/group.entity';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { User } from '../users/entities/user.entity';
import { TRUST_SCORE_FORMULA } from './trust-score.constants';

// ---------------------------------------------------------------------------
// Formula unit tests (pure function — no DI needed)
// ---------------------------------------------------------------------------
describe('computeTrustScore (formula)', () => {
  const zero: TrustScoreComponents = {
    onTimeContributions: 0,
    lateContributions: 0,
    missedContributions: 0,
    penaltiesIncurred: 0,
    penaltiesPaid: 0,
    groupsCompletedSuccessfully: 0,
    totalGroupsParticipated: 0,
  };

  it('returns 0 when user has no contributions at all', () => {
    expect(computeTrustScore(zero)).toBe(0);
  });

  it('returns 60 when all contributions are on-time and no penalties or completions', () => {
    const c: TrustScoreComponents = { ...zero, onTimeContributions: 10 };
    expect(computeTrustScore(c)).toBe(60);
  });

  it('returns 0 when all contributions are missed', () => {
    const c: TrustScoreComponents = { ...zero, missedContributions: 10 };
    expect(computeTrustScore(c)).toBe(0);
  });

  it('applies penalty deduction correctly', () => {
    // 10 on-time → base = 60; 2 outstanding penalties → -10; total = 50
    const c: TrustScoreComponents = {
      ...zero,
      onTimeContributions: 10,
      penaltiesIncurred: 2,
      penaltiesPaid: 0,
    };
    expect(computeTrustScore(c)).toBe(50);
  });

  it('does not deduct for paid penalties', () => {
    // 10 on-time → base = 60; 2 incurred, 2 paid → 0 outstanding → no deduction
    const c: TrustScoreComponents = {
      ...zero,
      onTimeContributions: 10,
      penaltiesIncurred: 2,
      penaltiesPaid: 2,
    };
    expect(computeTrustScore(c)).toBe(60);
  });

  it('applies completion bonus correctly', () => {
    // 10 on-time → base = 60; 3 completed groups → +12; total = 72
    const c: TrustScoreComponents = {
      ...zero,
      onTimeContributions: 10,
      groupsCompletedSuccessfully: 3,
    };
    expect(computeTrustScore(c)).toBe(72);
  });

  it('caps completion bonus at COMPLETION_BONUS_CAP (20)', () => {
    // 10 on-time → base = 60; 10 completed groups → bonus = min(40, 20) = 20; total = 80
    const c: TrustScoreComponents = {
      ...zero,
      onTimeContributions: 10,
      groupsCompletedSuccessfully: 10,
    };
    expect(computeTrustScore(c)).toBe(80);
  });

  it('clamps score to 100 maximum', () => {
    // 10 on-time → base = 60; 5 completed → +20; total = 80 (no overflow here)
    // Force overflow: 0 missed, 0 late, 0 penalties, 5 completed groups
    const c: TrustScoreComponents = {
      ...zero,
      onTimeContributions: 100,
      groupsCompletedSuccessfully: 5,
    };
    // base = 60, bonus = 20, total = 80 — still under 100
    expect(computeTrustScore(c)).toBeLessThanOrEqual(100);
  });

  it('clamps score to 0 minimum even with heavy penalties', () => {
    // 0 on-time, 100 outstanding penalties → would be deeply negative without clamp
    const c: TrustScoreComponents = {
      ...zero,
      missedContributions: 5,
      penaltiesIncurred: 100,
      penaltiesPaid: 0,
    };
    expect(computeTrustScore(c)).toBe(0);
  });

  it('produces score strictly in [0, 100] for mixed inputs', () => {
    const c: TrustScoreComponents = {
      onTimeContributions: 7,
      lateContributions: 2,
      missedContributions: 1,
      penaltiesIncurred: 3,
      penaltiesPaid: 1,
      groupsCompletedSuccessfully: 2,
      totalGroupsParticipated: 3,
    };
    const score = computeTrustScore(c);
    expect(score).toBeGreaterThanOrEqual(TRUST_SCORE_FORMULA.SCORE_MIN);
    expect(score).toBeLessThanOrEqual(TRUST_SCORE_FORMULA.SCORE_MAX);
  });
});

// ---------------------------------------------------------------------------
// TrustScoreService unit tests
// ---------------------------------------------------------------------------
describe('TrustScoreService', () => {
  let service: TrustScoreService;
  let trustScoreRepo: jest.Mocked<Repository<MemberTrustScore>>;
  let contributionRepo: jest.Mocked<Repository<Contribution>>;
  let penaltyRepo: jest.Mocked<Repository<Penalty>>;
  let membershipRepo: jest.Mocked<Repository<Membership>>;
  let groupRepo: jest.Mocked<Repository<Group>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockRepo = () => ({
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    upsert: jest.fn(),
    createQueryBuilder: jest.fn(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrustScoreService,
        { provide: getRepositoryToken(MemberTrustScore), useFactory: mockRepo },
        { provide: getRepositoryToken(Contribution), useFactory: mockRepo },
        { provide: getRepositoryToken(Penalty), useFactory: mockRepo },
        { provide: getRepositoryToken(Membership), useFactory: mockRepo },
        { provide: getRepositoryToken(Group), useFactory: mockRepo },
        { provide: getRepositoryToken(User), useFactory: mockRepo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<TrustScoreService>(TrustScoreService);
    trustScoreRepo = module.get(getRepositoryToken(MemberTrustScore));
    contributionRepo = module.get(getRepositoryToken(Contribution));
    penaltyRepo = module.get(getRepositoryToken(Penalty));
    membershipRepo = module.get(getRepositoryToken(Membership));
    groupRepo = module.get(getRepositoryToken(Group));
    userRepo = module.get(getRepositoryToken(User));
    eventEmitter = module.get(EventEmitter2);
  });

  // -------------------------------------------------------------------------
  // getTrustScore — access control
  // -------------------------------------------------------------------------
  describe('getTrustScore', () => {
    it('throws ForbiddenException when caller is neither the user nor a group admin', async () => {
      await expect(
        service.getTrustScore('user-1', 'other-user', 'user', false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows the user to view their own score', async () => {
      trustScoreRepo.findOne.mockResolvedValue({
        userId: 'user-1',
        score: 72,
        totalGroupsParticipated: 3,
        onTimeContributions: 10,
        lateContributions: 1,
        missedContributions: 0,
        penaltiesIncurred: 1,
        penaltiesPaid: 1,
        groupsCompletedSuccessfully: 2,
        lastCalculatedAt: new Date('2026-04-28'),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MemberTrustScore);

      const result = await service.getTrustScore('user-1', 'user-1', 'user', false);
      expect(result.userId).toBe('user-1');
      expect(result.score).toBe(72);
    });

    it('allows a platform admin to view any score', async () => {
      trustScoreRepo.findOne.mockResolvedValue({
        userId: 'user-1',
        score: 55,
        totalGroupsParticipated: 1,
        onTimeContributions: 5,
        lateContributions: 0,
        missedContributions: 0,
        penaltiesIncurred: 0,
        penaltiesPaid: 0,
        groupsCompletedSuccessfully: 1,
        lastCalculatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MemberTrustScore);

      const result = await service.getTrustScore('user-1', 'admin-user', 'admin', false);
      expect(result.score).toBe(55);
    });

    it('allows a group admin to view a member score', async () => {
      trustScoreRepo.findOne.mockResolvedValue({
        userId: 'user-1',
        score: 40,
        totalGroupsParticipated: 2,
        onTimeContributions: 4,
        lateContributions: 2,
        missedContributions: 1,
        penaltiesIncurred: 2,
        penaltiesPaid: 0,
        groupsCompletedSuccessfully: 0,
        lastCalculatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MemberTrustScore);

      const result = await service.getTrustScore('user-1', 'group-admin', 'user', true);
      expect(result.score).toBe(40);
    });

    it('returns zeroed placeholder when no score record exists yet', async () => {
      trustScoreRepo.findOne.mockResolvedValue(null);
      userRepo.findOne.mockResolvedValue({ id: 'user-1' } as User);

      const result = await service.getTrustScore('user-1', 'user-1', 'user', false);
      expect(result.score).toBe(0);
      expect(result.lastCalculatedAt).toBeNull();
    });

    it('throws NotFoundException when user does not exist and no score record', async () => {
      trustScoreRepo.findOne.mockResolvedValue(null);
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getTrustScore('ghost-user', 'ghost-user', 'user', false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // recalculateBatch — batch processing
  // -------------------------------------------------------------------------
  describe('recalculateBatch', () => {
    it('does nothing when userIds is empty', async () => {
      await service.recalculateBatch([]);
      expect(contributionRepo.find).not.toHaveBeenCalled();
    });

    it('upserts a trust score record for each user in the batch', async () => {
      const userIds = ['u1', 'u2'];

      contributionRepo.find.mockResolvedValue([
        { userId: 'u1', status: ContributionStatus.CONFIRMED } as Contribution,
        { userId: 'u1', status: ContributionStatus.CONFIRMED } as Contribution,
        { userId: 'u2', status: ContributionStatus.FAILED } as Contribution,
      ]);
      penaltyRepo.find.mockResolvedValue([
        { userId: 'u1', status: PenaltyStatus.PAID } as Penalty,
      ]);
      membershipRepo.find.mockResolvedValue([
        { userId: 'u1', groupId: 'g1' } as Membership,
        { userId: 'u2', groupId: 'g2' } as Membership,
      ]);
      groupRepo.find.mockResolvedValue([
        { id: 'g1', status: GroupStatus.COMPLETED } as Group,
      ]);
      trustScoreRepo.upsert.mockResolvedValue(undefined as any);

      await service.recalculateBatch(userIds);

      expect(trustScoreRepo.upsert).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'trust_score.updated',
        expect.objectContaining({ userId: 'u1' }),
      );
    });

    it('processes 200-user batches without exceeding call count', async () => {
      const userIds = Array.from({ length: 200 }, (_, i) => `user-${i}`);

      contributionRepo.find.mockResolvedValue([]);
      penaltyRepo.find.mockResolvedValue([]);
      membershipRepo.find.mockResolvedValue([]);
      groupRepo.find.mockResolvedValue([]);
      trustScoreRepo.upsert.mockResolvedValue(undefined as any);

      await service.recalculateBatch(userIds);

      // One upsert per user
      expect(trustScoreRepo.upsert).toHaveBeenCalledTimes(200);
      // Only one DB query per entity type (batch query)
      expect(contributionRepo.find).toHaveBeenCalledTimes(1);
      expect(penaltyRepo.find).toHaveBeenCalledTimes(1);
      expect(membershipRepo.find).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // isCallerGroupAdminOfUser
  // -------------------------------------------------------------------------
  describe('isCallerGroupAdminOfUser', () => {
    it('returns false when target user has no memberships', async () => {
      membershipRepo.find.mockResolvedValue([]);
      const result = await service.isCallerGroupAdminOfUser('caller', 'target');
      expect(result).toBe(false);
    });

    it('returns true when caller is admin of a group the target belongs to', async () => {
      membershipRepo.find.mockResolvedValue([
        { userId: 'target', groupId: 'g1' } as Membership,
      ]);
      userRepo.findOne.mockResolvedValue({ walletAddress: 'WALLET123' } as User);

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'g1' } as Group),
      };
      groupRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.isCallerGroupAdminOfUser('caller', 'target');
      expect(result).toBe(true);
    });

    it('returns false when caller is not admin of any group the target belongs to', async () => {
      membershipRepo.find.mockResolvedValue([
        { userId: 'target', groupId: 'g1' } as Membership,
      ]);
      userRepo.findOne.mockResolvedValue({ walletAddress: 'WALLET123' } as User);

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      groupRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.isCallerGroupAdminOfUser('caller', 'target');
      expect(result).toBe(false);
    });
  });
});
