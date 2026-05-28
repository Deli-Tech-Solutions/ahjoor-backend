import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { DistributedLockService } from './services/distributed-lock.service';
import { AuditLogService } from './services/audit-log.service';
import { ContributionSummaryService } from './services/contribution-summary.service';
import { GroupStatusService } from './services/group-status.service';
import { StaleGroupDetectionService } from './services/stale-group-detection.service';
import { RoundAdvanceService } from './services/round-advance.service';
import { ProfileIncompleteReminderService } from './services/profile-incomplete-reminder.service';
import { PenaltyAssessmentJob } from '../penalties/services/penalty-assessment.job';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { GroupInviteService } from '../groups/invites/group-invite.service';
import { QueueService } from '../bullmq/queue.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly maxRetries = 3;
  private readonly baseDelay = 1000; // 1 second

  constructor(
    private readonly lockService: DistributedLockService,
    private readonly auditLogService: AuditLogService,
    private readonly contributionSummaryService: ContributionSummaryService,
    private readonly groupStatusService: GroupStatusService,
    private readonly staleGroupDetectionService: StaleGroupDetectionService,
    private readonly roundAdvanceService: RoundAdvanceService,
    private readonly profileIncompleteReminderService: ProfileIncompleteReminderService,
    private readonly penaltyAssessmentJob: PenaltyAssessmentJob,
    private readonly configService: ConfigService,
    private readonly groupInviteService: GroupInviteService,
    private readonly queueService: QueueService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
  ) { }

  /**
   * Daily task: Archive old audit logs (runs at 2 AM)
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'archive-audit-logs',
  })
  async handleArchiveAuditLogs(): Promise<void> {
    const taskName = 'archive-audit-logs';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const archivedCount = await this.auditLogService.archiveOldLogs(90);
          return { archivedCount };
        }, taskName);
      },
      600, // 10 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Archived ${result.archivedCount} logs.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Weekly task: Send contribution summaries (runs every Monday at 9 AM)
   */
  @Cron(CronExpression.MONDAY_TO_FRIDAY_AT_9AM, {
    name: 'send-contribution-summaries',
  })
  async handleContributionSummaries(): Promise<void> {
    const taskName = 'send-contribution-summaries';
    const startTime = Date.now();

    // Only run on Mondays
    const today = new Date().getDay();
    if (today !== 1) {
      return;
    }

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const summaries =
            await this.contributionSummaryService.generateWeeklySummaries();
          await this.contributionSummaryService.sendSummariesToMembers(
            summaries,
          );
          return { summaryCount: summaries.length };
        }, taskName);
      },
      600, // 10 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Sent ${result.summaryCount} summaries.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Hourly task: Check and update group statuses
   */
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'update-group-statuses',
  })
  async handleGroupStatusUpdates(): Promise<void> {
    const taskName = 'update-group-statuses';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const updatedCount =
            await this.groupStatusService.updateGroupStatuses();
          const inactiveGroups =
            await this.groupStatusService.checkInactiveGroups();
          const advancedCount =
            await this.groupStatusService.advanceStalledRounds();
          return {
            updatedCount,
            inactiveGroupCount: inactiveGroups.length,
            advancedCount,
          };
        }, taskName);
      },
      300, // 5 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Updated ${result.updatedCount} groups, found ${result.inactiveGroupCount} inactive groups.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Daily task: Detect and flag stale groups (runs at 3 AM)
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'detect-stale-groups',
  })
  async handleStaleGroupDetection(): Promise<void> {
    const taskName = 'detect-stale-groups';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const flaggedCount =
            await this.staleGroupDetectionService.detectAndFlagStaleGroups();
          return { flaggedCount };
        }, taskName);
      },
      600, // 10 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Flagged ${result.flaggedCount} stale group(s).`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Every-minute task: Auto-advance group rounds when deadline passes.
   * Configurable via ROUND_ADVANCE_CRON env var (defaults to every minute).
   */
  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'auto-advance-rounds',
  })
  async handleAutoAdvanceRounds(): Promise<void> {
    const taskName = 'auto-advance-rounds';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          return await this.roundAdvanceService.processDeadlinedGroups();
        }, taskName);
      },
      55, // 55-second lock TTL — expires before next minute tick to stay idempotent
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed in ${duration}ms. Advanced: ${result.advanced}, Reminded: ${result.reminded}, Errors: ${result.errors}.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Daily task: Clean up expired refresh token rows (runs at 4 AM).
   * Keeps the refresh_tokens table lean and ensures expired tokens cannot be reused.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'cleanup-expired-refresh-tokens' })
  async handleCleanupExpiredRefreshTokens(): Promise<void> {
    const taskName = 'cleanup-expired-refresh-tokens';
    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const deleted = await this.refreshTokenRepository.delete({
            expiresAt: LessThan(new Date()),
          });
          return { deletedCount: deleted.affected ?? 0 };
        }, taskName);
      },
      300,
    );

    if (result) {
      this.logger.log(`Task ${taskName} completed. Deleted ${result.deletedCount} expired refresh tokens.`);
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Daily task: Expire stale group invites (runs at 2 AM UTC by default)
   * Configurable via GROUP_INVITE_EXPIRY_CRON env var.
   */
  @Cron(process.env.GROUP_INVITE_EXPIRY_CRON || CronExpression.EVERY_DAY_AT_2AM, {
    name: 'expire-group-invites',
  })
  async handleExpireGroupInvites(): Promise<void> {
    const taskName = 'expire-group-invites';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          const count = await this.groupInviteService.expireStaleInvites();
          return { count };
        }, taskName);
      },
      300,
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Expired ${result.count} invites.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Daily task: Send profile incomplete reminders (runs at 5 AM)
   * Sends reminder emails to users whose profile completeness score is below 60%
   * exactly 24 hours after registration.
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM, { name: 'send-profile-incomplete-reminders' })
  async handleProfileIncompleteReminders(): Promise<void> {
    const taskName = 'send-profile-incomplete-reminders';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          return await this.profileIncompleteReminderService.sendProfileIncompleteReminders();
        }, taskName);
      },
      600, // 10 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Sent ${result.sentCount} reminders.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Daily task: Assess penalties for missed contributions (runs at 6 AM)
   * Assesses penalties for members who missed their contribution deadline.
   * Penalties are calculated as: amount × rate × daysLate
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM, { name: 'assess-penalties' })
  async handlePenaltyAssessment(): Promise<void> {
    const taskName = 'assess-penalties';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          return await this.penaltyAssessmentJob.assessPenalties();
        }, taskName);
      },
      600, // 10 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Processed ${result.groupsProcessed} groups, assessed ${result.totalPenalties} penalties.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Nightly task: Recalculate cross-group member trust scores (runs at 1 AM).
   * Enqueues a BullMQ job that processes all users in batches of 200.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'recalculate-trust-scores' })
  async handleRecalculateTrustScores(): Promise<void> {
    const taskName = 'recalculate-trust-scores';
    const startTime = Date.now();

    this.logger.log(`Starting task: ${taskName}`);

    const result = await this.lockService.withLock(
      taskName,
      async () => {
        return await this.executeWithRetry(async () => {
          await this.queueService.addRecalculateTrustScores({
            enqueuedAt: new Date().toISOString(),
          });
          return { enqueued: true };
        }, taskName);
      },
      300, // 5 minutes lock TTL
    );

    const duration = Date.now() - startTime;

    if (result) {
      this.logger.log(
        `Task ${taskName} completed successfully in ${duration}ms. Trust score recalculation job enqueued.`,
      );
    } else {
      this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
    }
  }

  /**
   * Execute a task with exponential backoff retry logic
   */
  private async executeWithRetry<T>(fn: () => Promise<T>,
    taskName: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        this.logger.error(
          `Task ${taskName} failed on attempt ${attempt}/${this.maxRetries}:`,
          error,
        );

        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1);
          this.logger.log(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `Task ${taskName} failed after ${this.maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
