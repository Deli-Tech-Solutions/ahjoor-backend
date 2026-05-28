import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import { QUEUE_NAMES, JOB_NAMES, RETRY_CONFIG } from './queue.constants';
import {
  SendEmailJobData,
  SendNotificationEmailJobData,
  SendWelcomeEmailJobData,
  SyncOnChainEventJobData,
  ProcessTransferEventJobData,
  ProcessApprovalEventJobData,
  SyncGroupStateJobData,
  SyncAllGroupsJobData,
  ReconcilePayoutJobData,
  SendPushNotificationJobData,
  RecalculateTrustScoresJobData,
} from './queue.interfaces';
import { TxConfirmationJobData } from './tx-confirmation.processor';
import { injectTraceContext } from '../common/tracing/stellar-tracing';

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface AllQueueStats {
  queues: QueueStats[];
  deadLetter: QueueStats;
  retrievedAt: string;
}

// Shared job options with retry + custom backoff
function defaultJobOptions(overrides: Partial<JobsOptions> = {}): JobsOptions {
  return {
    attempts: RETRY_CONFIG.attempts,
    backoff: {
      type: 'custom',
    },
    removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
    removeOnFail: false,
    ...overrides,
  };
}

/** Attach W3C traceparent to job data so processors can restore the span. */
function withTraceContext<T extends Record<string, unknown>>(data: T): T & { _traceContext: Record<string, string> } {
  const carrier: Record<string, string> = {};
  injectTraceContext(carrier);
  return { ...data, _traceContext: carrier };
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EVENT_SYNC) private readonly eventSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.GROUP_SYNC) private readonly groupSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.PAYOUT_RECONCILIATION)
    private readonly payoutReconciliationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly deadLetterQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TX_CONFIRMATION)
    private readonly txConfirmationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.PUSH_NOTIFICATION)
    private readonly pushNotificationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.TRUST_SCORE)
    private readonly trustScoreQueue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Email queue helpers
  // ---------------------------------------------------------------------------
  async addSendEmail(data: SendEmailJobData, opts?: Partial<JobsOptions>) {
    return this.emailQueue.add(
      JOB_NAMES.SEND_EMAIL,
      data,
      defaultJobOptions(opts),
    );
  }

  async addSendNotificationEmail(
    data: SendNotificationEmailJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.emailQueue.add(
      JOB_NAMES.SEND_NOTIFICATION_EMAIL,
      data,
      defaultJobOptions(opts),
    );
  }

  async addSendWelcomeEmail(
    data: SendWelcomeEmailJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.emailQueue.add(
      JOB_NAMES.SEND_WELCOME_EMAIL,
      data,
      defaultJobOptions(opts),
    );
  }

  // ---------------------------------------------------------------------------
  // Event sync queue helpers
  // ---------------------------------------------------------------------------
  async addSyncOnChainEvent(
    data: SyncOnChainEventJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.eventSyncQueue.add(
      JOB_NAMES.SYNC_ON_CHAIN_EVENT,
      data,
      defaultJobOptions(opts),
    );
  }

  async addProcessTransferEvent(
    data: ProcessTransferEventJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.eventSyncQueue.add(
      JOB_NAMES.PROCESS_TRANSFER_EVENT,
      data,
      defaultJobOptions(opts),
    );
  }

  async addProcessApprovalEvent(
    data: ProcessApprovalEventJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.eventSyncQueue.add(
      JOB_NAMES.PROCESS_APPROVAL_EVENT,
      data,
      defaultJobOptions(opts),
    );
  }

  // ---------------------------------------------------------------------------
  // Group sync queue helpers
  // ---------------------------------------------------------------------------
  async addSyncGroupState(
    data: SyncGroupStateJobData,
    opts?: Partial<JobsOptions>,
  ) {
    const mergedOpts: Partial<JobsOptions> = { ...opts, jobId: data.groupId };
    return this.groupSyncQueue.add(
      JOB_NAMES.SYNC_GROUP_STATE,
      withTraceContext(data),
      defaultJobOptions(mergedOpts),
    );
  }

  async addSyncAllGroups(
    data: SyncAllGroupsJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.groupSyncQueue.add(
      JOB_NAMES.SYNC_ALL_GROUPS,
      data,
      defaultJobOptions(opts),
    );
  }

  async addPayoutReconciliation(
    data: ReconcilePayoutJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.payoutReconciliationQueue.add(
      JOB_NAMES.RECONCILE_PAYOUT,
      data,
      defaultJobOptions({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        jobId: data.payoutTransactionId,
        ...opts,
      }),
    );
  }

  async addTxConfirmation(data: TxConfirmationJobData, opts?: Partial<JobsOptions>) {
    return this.txConfirmationQueue.add(
      JOB_NAMES.CONFIRM_TRANSACTION,
      data,
      defaultJobOptions({
        attempts: 1, // processor handles its own polling loop
        jobId: `tx_confirm:${data.transactionHash}`,
        ...opts,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------
  async getStats(): Promise<AllQueueStats> {
    const [emailStats, eventStats, groupStats, payoutStats, dlStats, txStats] =
      await Promise.all([
        this.getQueueStats(this.emailQueue),
        this.getQueueStats(this.eventSyncQueue),
        this.getQueueStats(this.groupSyncQueue),
        this.getQueueStats(this.payoutReconciliationQueue),
        this.getQueueStats(this.deadLetterQueue),
        this.getQueueStats(this.txConfirmationQueue),
      ]);

    return {
      queues: [emailStats, eventStats, groupStats, payoutStats, txStats],
      deadLetter: dlStats,
      retrievedAt: new Date().toISOString(),
    };
  }

  private async getQueueStats(queue: Queue): Promise<QueueStats> {
    const [waiting, active, completed, failed, delayed, paused] =
      await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused().then((value) => (value ? 1 : 0)),
      ]);

    return {
      name: queue.name,
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused,
    };
  }

  // Expose queues for bull-board adapter
  getQueues(): Queue[] {
    return [
      this.emailQueue,
      this.eventSyncQueue,
      this.groupSyncQueue,
      this.payoutReconciliationQueue,
      this.deadLetterQueue,
      this.txConfirmationQueue,
      this.pushNotificationQueue,
    ];
  }

  // ---------------------------------------------------------------------------
  // Push notification queue helpers
  // ---------------------------------------------------------------------------
  async addSendPushNotification(
    data: SendPushNotificationJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.pushNotificationQueue.add(
      JOB_NAMES.SEND_PUSH,
      withTraceContext(data),
      defaultJobOptions(opts),
    );
  }

  // ---------------------------------------------------------------------------
  // Trust score queue helpers
  // ---------------------------------------------------------------------------
  async addRecalculateTrustScores(
    data: RecalculateTrustScoresJobData,
    opts?: Partial<JobsOptions>,
  ) {
    return this.trustScoreQueue.add(
      JOB_NAMES.RECALCULATE_TRUST_SCORES,
      data,
      defaultJobOptions({
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        ...opts,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Dead Letter Queue Management
  // ---------------------------------------------------------------------------
  async getDeadLetterJobs() {
    const jobs = await this.deadLetterQueue.getJobs([
      'completed',
      'failed',
      'waiting',
    ]);

    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
    }));
  }

  async retryDeadLetterJob(jobId: string) {
    const job = await this.deadLetterQueue.getJob(jobId);

    if (!job) {
      throw new Error(`Job ${jobId} not found in dead letter queue`);
    }

    const { originalQueue, originalJobName, originalJobData } = job.data;

    // Get the original queue
    let targetQueue: Queue;
    switch (originalQueue) {
      case QUEUE_NAMES.EMAIL:
        targetQueue = this.emailQueue;
        break;
      case QUEUE_NAMES.EVENT_SYNC:
        targetQueue = this.eventSyncQueue;
        break;
      case QUEUE_NAMES.GROUP_SYNC:
        targetQueue = this.groupSyncQueue;
        break;
      case QUEUE_NAMES.PAYOUT_RECONCILIATION:
        targetQueue = this.payoutReconciliationQueue;
        break;
      case QUEUE_NAMES.TX_CONFIRMATION:
        targetQueue = this.txConfirmationQueue;
        break;
      case QUEUE_NAMES.PUSH_NOTIFICATION:
        targetQueue = this.pushNotificationQueue;
        break;
      default:
        throw new Error(`Unknown queue: ${originalQueue}`);
    }

    // Re-add the job to the original queue
    await targetQueue.add(
      originalJobName,
      originalJobData,
      defaultJobOptions(),
    );

    // Remove from dead letter queue
    await job.remove();

    this.logger.log(
      `Retried job ${jobId} from dead letter queue to ${originalQueue}`,
    );

    return { success: true, message: `Job ${jobId} retried successfully` };
  }
}
