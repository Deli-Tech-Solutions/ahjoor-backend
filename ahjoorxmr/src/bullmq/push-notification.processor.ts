import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, JOB_NAMES, BACKOFF_DELAYS } from './queue.constants';
import { SendPushNotificationJobData } from './queue.interfaces';
import { DeadLetterService } from './dead-letter.service';
import { PushNotificationService } from '../notification/services/push-notification.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Processor for push notification jobs.
 * Handles sending push notifications via FCM and APNs with exponential backoff retries.
 */
@Processor(QUEUE_NAMES.PUSH_NOTIFICATION, {
  concurrency: 10,
  limiter: { max: 100, duration: 60_000 },
})
export class PushNotificationProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(PushNotificationProcessor.name);

  constructor(
    private readonly deadLetterService: DeadLetterService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly metricsService: MetricsService,
  ) {
    super();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log(
      `[${new Date().toISOString()}] Closing PushNotificationProcessor worker, draining active jobs...`,
    );
    try {
      await this.worker?.close();
      this.logger.log(
        `[${new Date().toISOString()}] PushNotificationProcessor worker closed successfully`,
      );
    } catch (error) {
      this.logger.error(
        `[${new Date().toISOString()}] Error closing PushNotificationProcessor worker: ${(error as Error).message}`,
      );
    }
  }

  async process(job: Job): Promise<unknown> {
    this.logger.debug(`Processing push notification job [${job.name}] id=${job.id}`);

    switch (job.name) {
      case JOB_NAMES.SEND_PUSH:
        return this.handleSendPush(job as Job<SendPushNotificationJobData>);
      default:
        throw new Error(`Unknown push notification job type: ${job.name}`);
    }
  }

  private async handleSendPush(
    job: Job<SendPushNotificationJobData>,
  ): Promise<{ successCount: number; failureCount: number }> {
    const { userId, title, body, data, notificationType } = job.data;
    this.logger.log(
      `Sending push notification userId=${userId} type=${notificationType} attempt=${job.attemptsMade + 1}/${job.opts?.attempts ?? 3}`,
    );

    const results = await this.pushNotificationService.sendPush(userId, {
      title,
      body,
      data,
    });

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    this.logger.log(
      `Push notification completed userId=${userId} success=${successCount} failures=${failureCount}`,
    );

    // If all deliveries failed, throw an error to trigger a retry
    if (failureCount > 0 && successCount === 0) {
      throw new Error(`All push notification deliveries failed for user ${userId}`);
    }

    return { successCount, failureCount };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`Push notification job completed [${job.name}] id=${job.id}`);
    this.metricsService.incrementBullMQJob(QUEUE_NAMES.PUSH_NOTIFICATION, 'completed');
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 3;
    this.logger.error(
      `Push notification job failed [${job.name}] id=${job.id} attempt=${job.attemptsMade}/${maxAttempts}: ${error.message}`,
      error.stack,
    );
    this.metricsService.incrementBullMQJob(QUEUE_NAMES.PUSH_NOTIFICATION, 'failed');

    if (job.attemptsMade >= maxAttempts) {
      this.logger.error(
        `Push notification job [${job.name}] id=${job.id} exhausted all retries → moving to dead-letter queue`,
      );
      await this.deadLetterService.moveToDeadLetter(
        job,
        error,
        QUEUE_NAMES.PUSH_NOTIFICATION,
      );
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Push notification job stalled id=${jobId}`);
  }
}

/**
 * Exponential backoff strategy for push notification retries.
 * Delays: 1s, 5s, 30s
 */
export function pushNotificationBackoffStrategy(attemptsMade: number): number {
  return BACKOFF_DELAYS[attemptsMade] ?? BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1];
}
