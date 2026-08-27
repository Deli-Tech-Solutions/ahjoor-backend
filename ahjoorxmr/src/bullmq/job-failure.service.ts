import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere, In, LessThan } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobFailure } from './entities/job-failure.entity';
import { QUEUE_NAMES } from './queue.constants';
import { PoisonMessageDetectorService } from './poison-message-detector.service';

export interface JobFailureFilter {
  queueName?: string;
  jobName?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
  isPoison?: boolean;
}

export interface BulkRetryFilter {
  ids?: string[];
  queueName?: string;
  errorType?: string;
  createdBefore?: string;
}

export interface RetryResult {
  id: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class JobFailureService {
  private readonly logger = new Logger(JobFailureService.name);

  constructor(
    @InjectRepository(JobFailure)
    private readonly repo: Repository<JobFailure>,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EVENT_SYNC) private readonly eventSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.GROUP_SYNC) private readonly groupSyncQueue: Queue,
    @InjectQueue(QUEUE_NAMES.PAYOUT_RECONCILIATION)
    private readonly payoutQueue: Queue,
    private readonly poisonMessageDetector: PoisonMessageDetectorService,
  ) {}

  private getQueueByName(queueName: string): Queue | undefined {
    const map: Record<string, Queue> = {
      [QUEUE_NAMES.EMAIL]: this.emailQueue,
      [QUEUE_NAMES.EVENT_SYNC]: this.eventSyncQueue,
      [QUEUE_NAMES.GROUP_SYNC]: this.groupSyncQueue,
      [QUEUE_NAMES.PAYOUT_RECONCILIATION]: this.payoutQueue,
    };
    return map[queueName];
  }

  async persist(
    jobId: string,
    jobName: string,
    queueName: string,
    error: Error,
    attemptNumber: number,
    data: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      // Check poison-message status for this job
      const poisonStatus = this.poisonMessageDetector.getPoisonStatus(jobId);
      const isPoison = poisonStatus?.consecutiveFailures !== undefined
        ? poisonStatus.consecutiveFailures >= 3
        : false;

      await this.repo.save(
        this.repo.create({
          jobId,
          jobName,
          queueName,
          error: error.message,
          stackTrace: error.stack ?? null,
          attemptNumber,
          data,
          status: isPoison ? 'POISON' : 'PENDING',
          isPoison,
          consecutiveFailures: poisonStatus?.consecutiveFailures ?? 1,
          failureSignature: poisonStatus?.signature ?? null,
          errorClass: poisonStatus?.errorClass ?? error.constructor?.name ?? 'Error',
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to persist job failure: ${(err as Error).message}`);
    }
  }

  async findAll(filter: JobFailureFilter): Promise<{ data: JobFailure[]; total: number }> {
    const { queueName, jobName, from, to, page = 1, limit = 20, isPoison } = filter;
    const where: FindOptionsWhere<JobFailure> = {};

    if (queueName) where.queueName = queueName;
    if (jobName) where.jobName = jobName;
    if (isPoison !== undefined) where.isPoison = isPoison;
    if (from || to) {
      where.failedAt = Between(
        from ? new Date(from) : new Date(0),
        to ? new Date(to) : new Date(),
      );
    }

    const [data, total] = await this.repo.findAndCount({
      where,
      order: { failedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total };
  }

  /**
   * Retry a single job by its JobFailure record ID.
   * Re-enqueues the original job payload and marks the record as RETRYING.
   */
  async retryById(id: string): Promise<{ record: JobFailure; enqueuedJobId: string }> {
    const record = await this.repo.findOneOrFail({ where: { id } });
    const queue = this.getQueueByName(record.queueName);

    if (!queue) {
      throw new Error(`Unknown queue: ${record.queueName}`);
    }

    const newJob = await queue.add(record.jobName, record.data ?? {}, {
      removeOnComplete: { count: 1000, age: 86_400 },
      removeOnFail: false,
    });

    await this.repo.update(id, {
      status: 'RETRYING',
      retryCount: record.retryCount + 1,
      lastRetriedAt: new Date(),
    });

    const updated = await this.repo.findOneOrFail({ where: { id } });
    // Clear poison-message tracking since the job is being retried
    this.poisonMessageDetector.clearJob(updated.jobId);
    return { record: updated, enqueuedJobId: String(newJob.id) };
  }

  /**
   * Bulk retry: accepts an array of IDs or a filter object.
   */
  async bulkRetry(input: BulkRetryFilter): Promise<{ results: RetryResult[]; total: number }> {
    let records: JobFailure[] = [];

    if (input.ids && input.ids.length > 0) {
      records = await this.repo.find({ where: { id: In(input.ids) } });
    } else {
      const where: FindOptionsWhere<JobFailure> = { status: 'PENDING' };
      if (input.queueName) where.queueName = input.queueName;
      if (input.createdBefore) where.failedAt = LessThan(new Date(input.createdBefore));
      records = await this.repo.find({ where });

      // errorType filter (substring match on error column)
      if (input.errorType) {
        records = records.filter((r) =>
          r.error?.toLowerCase().includes(input.errorType!.toLowerCase()),
        );
      }
    }

    const results: RetryResult[] = [];
    for (const record of records) {
      try {
        const queue = this.getQueueByName(record.queueName);
        if (!queue) throw new Error(`Unknown queue: ${record.queueName}`);

        const newJob = await queue.add(record.jobName, record.data ?? {}, {
          removeOnComplete: { count: 1000, age: 86_400 },
          removeOnFail: false,
        });

        await this.repo.update(record.id, {
          status: 'RETRYING',
          retryCount: record.retryCount + 1,
          lastRetriedAt: new Date(),
        });

        // Clear poison-message tracking since the job is being retried
        this.poisonMessageDetector.clearJob(record.jobId);

        this.logger.log(`Bulk-retried job failure ${record.id} → new job ${newJob.id}`);
        results.push({ id: record.id, success: true });
      } catch (err) {
        this.logger.warn(`Bulk retry failed for ${record.id}: ${(err as Error).message}`);
        results.push({ id: record.id, success: false, error: (err as Error).message });
      }
    }

    return { results, total: results.length };
  }

  async retryAll(): Promise<{ retried: number }> {
    const queues: Queue[] = [
      this.emailQueue,
      this.eventSyncQueue,
      this.groupSyncQueue,
      this.payoutQueue,
    ];

    let retried = 0;
    for (const queue of queues) {
      const failedJobs = await queue.getFailed();
      for (const job of failedJobs) {
        try {
          await job.retry();
          await this.repo.increment({ jobId: String(job.id) }, 'retryCount', 1);
          // Clear poison-message tracking since the job is being retried
          this.poisonMessageDetector.clearJob(String(job.id));
          retried++;
        } catch (err) {
          this.logger.warn(`Failed to retry job ${job.id}: ${(err as Error).message}`);
        }
      }
    }

    this.logger.log(`Retried ${retried} failed jobs`);
    return { retried };
  }

  async getMetrics(): Promise<{ jobs_failed_total: number; jobs_failed_by_queue: Record<string, number>; poison_messages_total: number }> {
    const total = await this.repo.count();
    const poisonTotal = await this.repo.count({ where: { isPoison: true } });
    const byQueue = await this.repo
      .createQueryBuilder('jf')
      .select('jf.queueName', 'queueName')
      .addSelect('COUNT(*)', 'count')
      .groupBy('jf.queueName')
      .getRawMany<{ queueName: string; count: string }>();

    const jobs_failed_by_queue: Record<string, number> = {};
    for (const row of byQueue) {
      jobs_failed_by_queue[row.queueName] = parseInt(row.count, 10);
    }

    return {
      jobs_failed_total: total,
      jobs_failed_by_queue,
      poison_messages_total: poisonTotal,
    };
  }
}
