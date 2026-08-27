import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError, LessThan } from 'typeorm';
import { Contribution, ContributionStatus } from './entities/contribution.entity';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { MembershipStatus } from '../memberships/entities/membership-status.enum';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { WinstonLogger } from '../common/logger/winston.logger';
import { CreateContributionDto } from './dto/create-contribution.dto';
import { StellarService } from '../stellar/stellar.service';
import { ConfigService } from '@nestjs/config';
import { GetContributionsQueryDto } from './dto/get-contributions-query.dto';
import { RoundService } from '../groups/round.service';
import { UseReadReplica } from '../common/decorators/read-replica.decorator';
import { WebhookService } from '../webhooks/webhook.service';
import { QueueService } from '../bullmq/queue.service';
import { GroupMaintenanceMixin } from '../common/services/group-maintenance.mixin';
import { RedisService } from '../common/redis/redis.service';
import { FxService } from '../fx/fx.service';
import { LockedFxRate } from '../fx/fx.types';

/** TTL for the in-flight Redis lock (seconds). Must exceed the longest expected Stellar submission. */
const IN_FLIGHT_LOCK_TTL_S = 60;
/** How long to poll for an in-flight result before giving up (ms). */
const IN_FLIGHT_POLL_TIMEOUT_MS = 55_000;
const IN_FLIGHT_POLL_INTERVAL_MS = 500;

/**
 * Service responsible for managing contribution operations in ROSCA groups.
 * Handles business logic for recording and querying member contributions.
 */
@Injectable()
export class ContributionsService {
  constructor(
    @InjectRepository(Contribution)
    private readonly contributionRepository: Repository<Contribution>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    private readonly logger: WinstonLogger,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly roundService: RoundService,
    private readonly webhookService: WebhookService,
    private readonly queueService: QueueService,
    private readonly groupMaintenanceMixin: GroupMaintenanceMixin,
    private readonly redisService: RedisService,
    private readonly fxService: FxService,
  ) {}

  /**
   * Validates that a group exists and returns it.
   *
   * @param groupId - The UUID of the group to validate
   * @returns The Group entity
   * @throws BadRequestException if the group doesn't exist
   * @private
   */
  private async validateGroupExists(groupId: string): Promise<Group> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      this.logger.warn(`Group ${groupId} not found`, 'ContributionsService');
      throw new BadRequestException('Invalid groupId or userId');
    }

    return group;
  }

  /**
   * Creates a new contribution record.
   * Validates that the group and user exist, checks for duplicate transaction hash,
   * validates round number matches current round, validates group is ACTIVE,
   * and creates the contribution record.
   *
   * @param createContributionDto - The contribution data
   * @returns The created Contribution entity
   * @throws BadRequestException if the group or user doesn't exist, round number is invalid, or group is not ACTIVE
   * @throws ConflictException if the transaction hash already exists
   */
  async createContribution(
    createContributionDto: CreateContributionDto,
    idempotencyKey?: string,
  ): Promise<Contribution> {
    const { groupId, userId, transactionHash, roundNumber } = createContributionDto;

    this.logger.log(
      `Creating contribution for user ${userId} in group ${groupId} tx=${transactionHash}`,
      'ContributionsService',
    );

    // ── 1. Idempotency: if a completed record already exists for this key, return it ──
    if (idempotencyKey) {
      const existing = await this.contributionRepository.findOne({
        where: { idempotencyKey },
      });
      if (existing) {
        if (
          existing.status === ContributionStatus.CONFIRMED ||
          existing.status === ContributionStatus.FAILED
        ) {
          this.logger.log(
            `Idempotency hit (terminal): key=${idempotencyKey} id=${existing.id}`,
            'ContributionsService',
          );
          return existing;
        }

        // Status is PENDING or ON_CHAIN_SUBMITTED — another request is in-flight.
        // Block and wait for it to reach a terminal state.
        return this.waitForInFlight(idempotencyKey, existing.id);
      }
    }

    // ── 2. Acquire in-flight lock so concurrent retries queue behind us ──
    const lockKey = idempotencyKey ? `contrib:inflight:${idempotencyKey}` : null;
    if (lockKey) {
      const acquired = await this.redisService.setIfNotExistsWithExpiry(
        lockKey,
        'locked',
        IN_FLIGHT_LOCK_TTL_S,
      );
      if (!acquired) {
        // Another request is already processing this key — wait for it.
        const existingAfterLock = await this.contributionRepository.findOne({
          where: { idempotencyKey },
        });
        if (existingAfterLock) {
          return this.waitForInFlight(idempotencyKey!, existingAfterLock.id);
        }
        // Lock exists but no DB row yet — wait briefly and retry once
        await new Promise((r) => setTimeout(r, IN_FLIGHT_POLL_INTERVAL_MS));
        const retryExisting = await this.contributionRepository.findOne({
          where: { idempotencyKey },
        });
        if (retryExisting) {
          return this.waitForInFlight(idempotencyKey!, retryExisting.id);
        }
        throw new ConflictException('Concurrent request with same idempotency key is in progress');
      }
    }

    try {
      // ── 3. Validate group / membership / window / round ──
      const group = await this.validateGroupExists(groupId);
      await this.groupMaintenanceMixin.checkGroupMaintenance(groupId);

      const membership = await this.membershipRepository.findOne({ where: { groupId, userId } });
      if (membership?.status === MembershipStatus.SUSPENDED) {
        throw new ForbiddenException('Suspended members cannot submit contributions');
      }

      if (group.status !== GroupStatus.ACTIVE) {
        throw new BadRequestException('Contributions can only be made to ACTIVE groups');
      }

      const now = new Date();
      if (group.startDate && now < group.startDate) {
        throw new BadRequestException(
          `Contribution window has not opened yet (opens at ${group.startDate.toISOString()} in timezone ${group.timezone ?? 'UTC'})`,
        );
      }
      if (group.endDate && now > group.endDate) {
        throw new BadRequestException(
          `Contribution window has closed (closed at ${group.endDate.toISOString()} in timezone ${group.timezone ?? 'UTC'})`,
        );
      }

      if (roundNumber !== group.currentRound) {
        throw new BadRequestException('Contributions can only be made for the current round');
      }

      // ── 4. Stellar verification + FX rate locking ──
      let lockedRate: LockedFxRate | null = null;
      let normalizedAmount: string | null = null;

      const shouldVerify = this.configService.get<boolean>('VERIFY_CONTRIBUTIONS', true);
      if (shouldVerify) {
        const isValid = await this.stellarService.verifyContributionForGroup(
          transactionHash,
          group.contractAddress ?? null,
        );
        if (!isValid) {
          throw new BadRequestException(
            'Transaction hash does not correspond to a valid contribution',
          );
        }

        try {
          const txDetails = await this.stellarService.getTransactionAmount(transactionHash);
          const txAsset = txDetails.assetCode.toUpperCase();

          // Determine the contribution asset (what the member actually paid in).
          const contributionAsset = this.fxService.getContributionAsset(
            group,
            txAsset,
            txDetails.assetIssuer,
          );

          // Capture and lock the FX rate at submission time.
          lockedRate = await this.fxService.lockRate(group, contributionAsset);

          // Normalize the contribution amount to the group's unit of account.
          const normalized = await this.fxService.normalizeToUnitOfAccount(
            group,
            txDetails.amount,
            contributionAsset,
            lockedRate,
          );
          normalizedAmount = normalized.normalized;

          // Verify the normalized amount meets the required contribution.
          const normalizedNum = Number(normalizedAmount);
          const requiredAmountNum = Number(group.contributionAmount);
          if (isNaN(normalizedNum) || isNaN(requiredAmountNum)) {
            throw new BadRequestException('Unable to parse transaction amount for verification');
          }
          if (normalizedNum < requiredAmountNum) {
            throw new BadRequestException(
              `Contribution value (${normalizedAmount} ${group.unitOfAccountAssetCode ?? group.assetCode ?? 'XLM'}) is less than required contribution amount (${group.contributionAmount})`,
            );
          }
        } catch (amountError) {
          if (amountError instanceof BadRequestException) throw amountError;
          this.logger.error(
            `Failed to verify transaction amount for ${transactionHash}: ${(amountError as Error).message}`,
            (amountError as Error).stack,
            'ContributionsService',
          );
          throw new BadRequestException(
            `Failed to verify transaction amount: ${(amountError as Error).message}`,
          );
        }
      }

      // ── 5. Persist with status=PENDING (phase 1 complete) ──
      const insertResult = await this.contributionRepository
        .createQueryBuilder()
        .insert()
        .into(Contribution)
        .values({
          groupId,
          userId,
          walletAddress: createContributionDto.walletAddress,
          roundNumber,
          amount: createContributionDto.amount,
          transactionHash,
          timestamp: createContributionDto.timestamp,
          assetCode: group.assetCode ?? 'XLM',
          assetIssuer: group.assetIssuer ?? null,
          unitOfAccountAssetCode: group.unitOfAccountAssetCode ?? group.assetCode ?? 'XLM',
          unitOfAccountAssetIssuer: group.unitOfAccountAssetIssuer ?? group.assetIssuer ?? null,
          fxRate: lockedRate?.rate ?? '1',
          fxRateCapturedAt: lockedRate ? new Date(lockedRate.capturedAt) : null,
          fxRateExpiresAt: lockedRate ? new Date(lockedRate.expiresAt) : null,
          fxToleranceBps: lockedRate?.toleranceBps ?? group.fxToleranceBps ?? 200,
          normalizedAmount,
          status: ContributionStatus.PENDING,
          idempotencyKey: idempotencyKey ?? null,
        })
        .orIgnore()
        .execute();

      if (!insertResult.identifiers?.length) {
        throw new ConflictException(
          'A contribution for this user and round already exists in this group, or this transaction was already recorded',
        );
      }

      const newId = insertResult.identifiers[0].id as string;
      const savedContribution = await this.contributionRepository.findOne({ where: { id: newId } });
      if (!savedContribution) {
        throw new ConflictException(
          'A contribution for this user and round already exists in this group, or this transaction was already recorded',
        );
      }

      this.logger.log(
        `Contribution ${savedContribution.id} persisted (PENDING) for user ${userId} in group ${groupId}`,
        'ContributionsService',
      );

      // ── 6. Transition to ON_CHAIN_SUBMITTED (phase 2 begins) ──
      await this.contributionRepository.update(savedContribution.id, {
        status: ContributionStatus.ON_CHAIN_SUBMITTED,
      });
      savedContribution.status = ContributionStatus.ON_CHAIN_SUBMITTED;

      // ── 7. Enqueue confirmation job (phase 2 tracking) ──
      const timeoutMs = this.configService.get<number>('TX_CONFIRMATION_TIMEOUT_MS', 120_000);
      this.queueService
        .addTxConfirmation({
          contributionId: savedContribution.id,
          transactionHash: savedContribution.transactionHash,
          userId: savedContribution.userId,
          deadline: Date.now() + timeoutMs,
        })
        .catch((err) => {
          this.logger.error(
            `Failed to enqueue tx confirmation for contribution ${savedContribution.id}: ${err.message}`,
            err.stack,
            'ContributionsService',
          );
        });

      // ── 8. Async side-effects ──
      this.webhookService.notifyContributionVerified(savedContribution).catch((err) => {
        this.logger.error(
          `Webhook failed for contribution ${savedContribution.id}: ${err.message}`,
          err.stack,
          'ContributionsService',
        );
      });

      await this.roundService.tryAdvanceRound(groupId);

      return savedContribution;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof HttpException
      ) {
        throw error;
      }

      if (error instanceof QueryFailedError) {
        const pgError = error as any;
        if (pgError.code === '23505') {
          const constraint = pgError.constraint || '';
          if (constraint === 'UQ_contributions_userId_groupId_roundNumber') {
            throw new ConflictException(
              'A contribution for this user and round already exists in this group',
            );
          }
          throw new ConflictException('Contribution with this transaction hash already exists');
        }
        if (pgError.code === '23503') {
          throw new BadRequestException('Invalid groupId or userId');
        }
      }

      this.logger.error(
        `Failed to create contribution for user ${userId} in group ${groupId}: ${(error as Error).message}`,
        (error as Error).stack,
        'ContributionsService',
      );
      throw error;
    } finally {
      // Always release the in-flight lock
      if (lockKey) {
        await this.redisService.del(lockKey);
      }
    }
  }

  /**
   * Polls until the contribution with the given idempotency key reaches a terminal state.
   * Used to serialize concurrent retries of the same idempotency key.
   */
  private async waitForInFlight(idempotencyKey: string, contributionId: string): Promise<Contribution> {
    const deadline = Date.now() + IN_FLIGHT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, IN_FLIGHT_POLL_INTERVAL_MS));
      const contribution = await this.contributionRepository.findOne({
        where: { id: contributionId },
      });
      if (!contribution) {
        throw new ConflictException('In-flight contribution disappeared unexpectedly');
      }
      if (
        contribution.status === ContributionStatus.CONFIRMED ||
        contribution.status === ContributionStatus.FAILED
      ) {
        this.logger.log(
          `In-flight wait resolved: key=${idempotencyKey} id=${contributionId} status=${contribution.status}`,
          'ContributionsService',
        );
        return contribution;
      }
    }
    // Timed out waiting — return the current (non-terminal) record so the caller
    // can decide what to do; reconciliation will eventually resolve it.
    const contribution = await this.contributionRepository.findOneOrFail({
      where: { id: contributionId },
    });
    return contribution;
  }

  /**
   * Reconciles contributions stuck in ON_CHAIN_SUBMITTED by querying Stellar directly.
   * Called by the reconciliation scheduler on startup and periodically.
   */
  async reconcileStuckContributions(staleAfterMs = 60_000): Promise<void> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stuck = await this.contributionRepository.find({
      where: { status: ContributionStatus.ON_CHAIN_SUBMITTED, updatedAt: LessThan(cutoff) },
    });

    if (!stuck.length) return;

    this.logger.log(
      `Reconciling ${stuck.length} ON_CHAIN_SUBMITTED contribution(s) older than ${staleAfterMs}ms`,
      'ContributionsService',
    );

    await Promise.allSettled(
      stuck.map(async (contribution) => {
        try {
          const txStatus = await this.stellarService.getTransactionStatus(
            contribution.transactionHash,
          );

          let newStatus: ContributionStatus | null = null;
          if (txStatus === 'CONFIRMED') newStatus = ContributionStatus.CONFIRMED;
          else if (txStatus === 'FAILED') newStatus = ContributionStatus.FAILED;

          if (newStatus) {
            await this.contributionRepository.update(contribution.id, { status: newStatus });
            this.logger.log(
              `Reconciled contribution ${contribution.id} → ${newStatus} (tx=${contribution.transactionHash})`,
              'ContributionsService',
            );
          }
        } catch (err) {
          this.logger.error(
            `Reconciliation failed for contribution ${contribution.id}: ${(err as Error).message}`,
            (err as Error).stack,
            'ContributionsService',
          );
        }
      }),
    );
  }

  /**
   * Retrieves all contributions for a specific group with pagination, sorting, and filtering.
   *
   * @param groupId - The UUID of the group
   * @param query - The pagination and filter query parameters
   * @returns Paginated envelope containing contribution entities
   */
  @UseReadReplica()
  async getGroupContributions(
    groupId: string,
    query: GetContributionsQueryDto,
  ): Promise<{
    data: Contribution[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const {
      page = 1,
      limit = 20,
      round,
      walletAddress,
      sortBy = 'timestamp',
      sortOrder = 'DESC',
    } = query;

    this.logger.log(
      `Querying contributions for group ${groupId} with pagination: page=${page}, limit=${limit}, sortBy=${sortBy}, sortOrder=${sortOrder}${round ? `, round=${round}` : ''}${walletAddress ? `, walletAddress=${walletAddress}` : ''}`,
      'ContributionsService',
    );

    const whereClause: any = { groupId };

    if (round !== undefined) {
      whereClause.roundNumber = round;
    }

    if (walletAddress) {
      whereClause.walletAddress = walletAddress;
    }

    const [data, total] = await this.contributionRepository.findAndCount({
      where: whereClause,
      order: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);

    this.logger.log(
      `Found ${data.length} contribution(s) (total ${total}) for group ${groupId}`,
      'ContributionsService',
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Retrieves all contributions for a specific group and round.
   *
   * @param groupId - The UUID of the group
   * @param round - The round number to query
   * @returns Array of Contribution entities (empty if none found)
   */
  async getRoundContributions(
    groupId: string,
    round: number,
  ): Promise<Contribution[]> {
    this.logger.log(
      `Querying contributions for group ${groupId} and round ${round}`,
      'ContributionsService',
    );

    const contributions = await this.contributionRepository.find({
      where: {
        groupId,
        roundNumber: round,
      },
      order: { timestamp: 'DESC' },
    });

    this.logger.log(
      `Found ${contributions.length} contribution(s) for group ${groupId} and round ${round}`,
      'ContributionsService',
    );

    return contributions;
  }

  /**
   * Retrieves all contributions for a specific user across all groups.
   *
   * @param userId - The UUID of the user
   * @returns Array of Contribution entities (empty if none found)
   */
  async getUserContributions(userId: string): Promise<Contribution[]> {
    this.logger.log(
      `Querying contributions for user ${userId}`,
      'ContributionsService',
    );

    const contributions = await this.contributionRepository.find({
      where: { userId },
      order: { timestamp: 'DESC' },
    });

    this.logger.log(
      `Found ${contributions.length} contribution(s) for user ${userId}`,
      'ContributionsService',
    );

    return contributions;
  }
}
