import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, JOB_NAMES } from '../bullmq/queue.constants';
import { RecalculateTrustScoresJobData } from '../bullmq/queue.interfaces';
import { TrustScoreService } from './trust-score.service';

/**
 * BullMQ processor for the trust-score-queue.
 * Handles the RECALCULATE_TRUST_SCORES job which runs nightly.
 */
@Processor(QUEUE_NAMES.TRUST_SCORE, {
  concurrency: 1, // Single worker to avoid DB connection pool exhaustion
})
export class TrustScoreRecalculationProcessor extends WorkerHost {
  private readonly logger = new Logger(TrustScoreRecalculationProcessor.name);

  constructor(private readonly trustScoreService: TrustScoreService) {
    super();
  }

  async process(job: Job<RecalculateTrustScoresJobData>): Promise<{ processed: number }> {
    this.logger.log(
      `Processing trust score job [${job.name}] id=${job.id} enqueued at ${job.data.enqueuedAt}`,
    );

    switch (job.name) {
      case JOB_NAMES.RECALCULATE_TRUST_SCORES:
        return this.handleRecalculate(job);
      default:
        throw new Error(`Unknown trust score job type: ${job.name}`);
    }
  }

  private async handleRecalculate(
    job: Job<RecalculateTrustScoresJobData>,
  ): Promise<{ processed: number }> {
    const { userIds } = job.data;

    let processed: number;

    if (userIds && userIds.length > 0) {
      // Targeted recalculation for a specific set of users
      await this.trustScoreService.recalculateBatch(userIds);
      processed = userIds.length;
    } else {
      // Full nightly recalculation for all users
      processed = await this.trustScoreService.recalculateAll();
    }

    this.logger.log(
      `Trust score recalculation complete. Processed ${processed} users.`,
    );

    return { processed };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Trust score job [${job.name}] id=${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job, result: { processed: number }): void {
    this.logger.log(
      `Trust score job [${job.name}] id=${job.id} completed. Processed ${result?.processed ?? 0} users.`,
    );
  }
}
