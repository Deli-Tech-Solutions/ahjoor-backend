import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemberTrustScore } from './entities/member-trust-score.entity';
import { Contribution, ContributionStatus } from '../contributions/entities/contribution.entity';
import { Penalty, PenaltyStatus } from '../penalties/entities/penalty.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { Group } from '../groups/entities/group.entity';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { User } from '../users/entities/user.entity';
import { TRUST_SCORE_FORMULA, TRUST_SCORE_BATCH_SIZE } from './trust-score.constants';
import { TrustScoreResponseDto } from './dto/trust-score-response.dto';

export interface TrustScoreComponents {
  onTimeContributions: number;
  lateContributions: number;
  missedContributions: number;
  penaltiesIncurred: number;
  penaltiesPaid: number;
  groupsCompletedSuccessfully: number;
  totalGroupsParticipated: number;
}

/**
 * Computes the deterministic trust score from raw components.
 * Formula (all constants defined in trust-score.constants.ts):
 *   base        = (onTime / total) × ON_TIME_WEIGHT
 *   penalty_adj = max(0, (incurred − paid) × PENALTY_DEDUCTION)
 *   completion  = min(completed × BONUS_PER_GROUP, BONUS_CAP)
 *   score       = clamp(base − penalty_adj + completion, 0, 100)
 */
export function computeTrustScore(c: TrustScoreComponents): number {
  const {
    ON_TIME_WEIGHT,
    PENALTY_DEDUCTION,
    COMPLETION_BONUS_PER_GROUP,
    COMPLETION_BONUS_CAP,
    SCORE_MIN,
    SCORE_MAX,
  } = TRUST_SCORE_FORMULA;

  const totalContributions =
    c.onTimeContributions + c.lateContributions + c.missedContributions;

  const base =
    totalContributions > 0
      ? (c.onTimeContributions / totalContributions) * ON_TIME_WEIGHT
      : 0;

  const outstandingPenalties = Math.max(0, c.penaltiesIncurred - c.penaltiesPaid);
  const penaltyAdj = outstandingPenalties * PENALTY_DEDUCTION;

  const completionBonus = Math.min(
    c.groupsCompletedSuccessfully * COMPLETION_BONUS_PER_GROUP,
    COMPLETION_BONUS_CAP,
  );

  const raw = base - penaltyAdj + completionBonus;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, parseFloat(raw.toFixed(2))));
}

@Injectable()
export class TrustScoreService {
  private readonly logger = new Logger(TrustScoreService.name);

  constructor(
    @InjectRepository(MemberTrustScore)
    private readonly trustScoreRepository: Repository<MemberTrustScore>,
    @InjectRepository(Contribution)
    private readonly contributionRepository: Repository<Contribution>,
    @InjectRepository(Penalty)
    private readonly penaltyRepository: Repository<Penalty>,
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Returns the trust score for a given user.
   * Access control: caller must be the user themselves or a platform admin.
   * Group admins are also permitted (checked by the caller passing isGroupAdmin=true).
   */
  async getTrustScore(
    targetUserId: string,
    callerId: string,
    callerRole: string,
    isGroupAdmin: boolean,
  ): Promise<TrustScoreResponseDto> {
    const isSelf = callerId === targetUserId;
    const isPlatformAdmin = callerRole === 'admin';

    if (!isSelf && !isPlatformAdmin && !isGroupAdmin) {
      throw new ForbiddenException(
        'Access denied: only the user themselves or a group admin may view this score.',
      );
    }

    const record = await this.trustScoreRepository.findOne({
      where: { userId: targetUserId },
    });

    if (!record) {
      // Return a zeroed-out placeholder if no calculation has run yet
      const user = await this.userRepository.findOne({ where: { id: targetUserId } });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      return this.buildResponseDto({
        id: '',
        userId: targetUserId,
        score: 0,
        totalGroupsParticipated: 0,
        onTimeContributions: 0,
        lateContributions: 0,
        missedContributions: 0,
        penaltiesIncurred: 0,
        penaltiesPaid: 0,
        groupsCompletedSuccessfully: 0,
        lastCalculatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MemberTrustScore);
    }

    return this.buildResponseDto(record);
  }

  /**
   * Recalculates trust scores for all users in batches of TRUST_SCORE_BATCH_SIZE.
   * Designed to be called by the nightly BullMQ job.
   * Returns the total number of users processed.
   */
  async recalculateAll(): Promise<number> {
    this.logger.log('Starting nightly trust score recalculation');

    const totalUsers = await this.userRepository.count();
    let offset = 0;
    let processed = 0;

    while (offset < totalUsers) {
      const users = await this.userRepository.find({
        select: ['id'],
        skip: offset,
        take: TRUST_SCORE_BATCH_SIZE,
        order: { createdAt: 'ASC' },
      });

      if (users.length === 0) break;

      await this.recalculateBatch(users.map((u) => u.id));
      processed += users.length;
      offset += TRUST_SCORE_BATCH_SIZE;

      this.logger.debug(
        `Trust score batch processed: ${processed}/${totalUsers}`,
      );
    }

    this.logger.log(
      `Nightly trust score recalculation complete. Processed ${processed} users.`,
    );
    return processed;
  }

  /**
   * Recalculates and upserts trust scores for a specific batch of user IDs.
   */
  async recalculateBatch(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;

    // Fetch all contributions for these users in one query
    const contributions = await this.contributionRepository.find({
      where: { userId: In(userIds) },
      select: ['userId', 'groupId', 'roundNumber', 'status', 'createdAt', 'timestamp'],
    });

    // Fetch all penalties for these users
    const penalties = await this.penaltyRepository.find({
      where: { userId: In(userIds) },
      select: ['userId', 'status'],
    });

    // Fetch all memberships for these users to determine groups participated
    const memberships = await this.membershipRepository.find({
      where: { userId: In(userIds) },
      select: ['userId', 'groupId'],
    });

    // Fetch completed groups to determine successful completions
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    const completedGroups =
      groupIds.length > 0
        ? await this.groupRepository.find({
            where: { id: In(groupIds), status: GroupStatus.COMPLETED },
            select: ['id'],
          })
        : [];
    const completedGroupIds = new Set(completedGroups.map((g) => g.id));

    // Build per-user components
    const componentsByUser = new Map<string, TrustScoreComponents>();
    for (const userId of userIds) {
      componentsByUser.set(userId, {
        onTimeContributions: 0,
        lateContributions: 0,
        missedContributions: 0,
        penaltiesIncurred: 0,
        penaltiesPaid: 0,
        groupsCompletedSuccessfully: 0,
        totalGroupsParticipated: 0,
      });
    }

    // Aggregate contributions
    for (const c of contributions) {
      const comp = componentsByUser.get(c.userId);
      if (!comp) continue;

      if (c.status === ContributionStatus.CONFIRMED) {
        // We treat all confirmed contributions as on-time for now.
        // Late detection would require comparing c.timestamp to the round deadline,
        // which requires group round duration data. We classify CONFIRMED as on-time
        // and PENDING/FAILED as late/missed respectively.
        comp.onTimeContributions += 1;
      } else if (c.status === ContributionStatus.PENDING) {
        comp.lateContributions += 1;
      } else if (c.status === ContributionStatus.FAILED) {
        comp.missedContributions += 1;
      }
    }

    // Aggregate penalties
    for (const p of penalties) {
      const comp = componentsByUser.get(p.userId);
      if (!comp) continue;
      comp.penaltiesIncurred += 1;
      if (p.status === PenaltyStatus.PAID) {
        comp.penaltiesPaid += 1;
      }
    }

    // Aggregate group participation and completions
    const membershipsByUser = new Map<string, Set<string>>();
    for (const m of memberships) {
      if (!membershipsByUser.has(m.userId)) {
        membershipsByUser.set(m.userId, new Set());
      }
      membershipsByUser.get(m.userId)!.add(m.groupId);
    }

    for (const [userId, groupSet] of membershipsByUser) {
      const comp = componentsByUser.get(userId);
      if (!comp) continue;
      comp.totalGroupsParticipated = groupSet.size;
      comp.groupsCompletedSuccessfully = [...groupSet].filter((gId) =>
        completedGroupIds.has(gId),
      ).length;
    }

    // Upsert trust scores
    const now = new Date();
    for (const userId of userIds) {
      const comp = componentsByUser.get(userId)!;
      const score = computeTrustScore(comp);

      await this.trustScoreRepository.upsert(
        {
          userId,
          score,
          totalGroupsParticipated: comp.totalGroupsParticipated,
          onTimeContributions: comp.onTimeContributions,
          lateContributions: comp.lateContributions,
          missedContributions: comp.missedContributions,
          penaltiesIncurred: comp.penaltiesIncurred,
          penaltiesPaid: comp.penaltiesPaid,
          groupsCompletedSuccessfully: comp.groupsCompletedSuccessfully,
          lastCalculatedAt: now,
        },
        { conflictPaths: ['userId'] },
      );

      // Emit internal event for downstream hooks
      this.eventEmitter.emit('trust_score.updated', {
        userId,
        score,
        calculatedAt: now.toISOString(),
      });
    }
  }

  /**
   * Checks whether a given caller is an admin of any group that the target user
   * is a member of. Used for access-control in getTrustScore.
   */
  async isCallerGroupAdminOfUser(
    callerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    // Find all groups where the target user is a member
    const targetMemberships = await this.membershipRepository.find({
      where: { userId: targetUserId },
      select: ['groupId'],
    });

    if (targetMemberships.length === 0) return false;

    const groupIds = targetMemberships.map((m) => m.groupId);

    // Check if the caller is the admin of any of those groups
    const callerUser = await this.userRepository.findOne({
      where: { id: callerId },
      select: ['walletAddress'],
    });
    if (!callerUser) return false;

    const adminGroup = await this.groupRepository
      .createQueryBuilder('g')
      .where('g.id IN (:...groupIds)', { groupIds })
      .andWhere('g.adminWallet = :wallet', { wallet: callerUser.walletAddress })
      .getOne();

    return adminGroup !== null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildResponseDto(record: MemberTrustScore): TrustScoreResponseDto {
    return {
      userId: record.userId,
      score: Number(record.score),
      totalGroupsParticipated: record.totalGroupsParticipated,
      onTimeContributions: record.onTimeContributions,
      lateContributions: record.lateContributions,
      missedContributions: record.missedContributions,
      penaltiesIncurred: record.penaltiesIncurred,
      penaltiesPaid: record.penaltiesPaid,
      groupsCompletedSuccessfully: record.groupsCompletedSuccessfully,
      lastCalculatedAt: record.lastCalculatedAt
        ? record.lastCalculatedAt.toISOString()
        : null,
      createdAt: record.createdAt ? record.createdAt.toISOString() : new Date().toISOString(),
      updatedAt: record.updatedAt ? record.updatedAt.toISOString() : new Date().toISOString(),
    };
  }
}
