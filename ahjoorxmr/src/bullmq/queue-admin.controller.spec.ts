import { Test, TestingModule } from '@nestjs/testing';
import { QueueAdminController } from './queue-admin.controller';
import { QueueService, AllQueueStats } from './queue.service';
import { JobFailureService } from './job-failure.service';
import { PoisonMessageDetectorService } from './poison-message-detector.service';
import { DeadLetterAlertingService } from './dead-letter-alerting.service';
import { CircuitBreakerAwareBackoffService } from './circuit-breaker-aware-backoff.service';
import { AuditService } from '../audit/audit.service';
import { QUEUE_NAMES } from './queue.constants';
import { NotFoundException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const mockStats: AllQueueStats = {
  queues: [
    {
      name: QUEUE_NAMES.EMAIL,
      waiting: 2,
      active: 1,
      completed: 50,
      failed: 0,
      delayed: 0,
      paused: 0,
    },
    {
      name: QUEUE_NAMES.EVENT_SYNC,
      waiting: 0,
      active: 0,
      completed: 10,
      failed: 1,
      delayed: 0,
      paused: 0,
    },
    {
      name: QUEUE_NAMES.GROUP_SYNC,
      waiting: 1,
      active: 0,
      completed: 5,
      failed: 0,
      delayed: 0,
      paused: 0,
    },
  ],
  deadLetter: {
    name: QUEUE_NAMES.DEAD_LETTER,
    waiting: 1,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
  },
  retrievedAt: new Date().toISOString(),
};

const adminRequest = { user: { id: 'admin-user-uuid', role: 'admin' } };

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('QueueAdminController', () => {
  let controller: QueueAdminController;
  let queueService: jest.Mocked<QueueService>;
  let jobFailureService: jest.Mocked<JobFailureService>;
  let auditService: jest.Mocked<AuditService>;
  let poisonDetector: jest.Mocked<PoisonMessageDetectorService>;
  let alertingService: jest.Mocked<DeadLetterAlertingService>;
  let backoffService: jest.Mocked<CircuitBreakerAwareBackoffService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QueueAdminController],
      providers: [
        {
          provide: QueueService,
          useValue: {
            getStats: jest.fn().mockResolvedValue(mockStats),
            getDeadLetterJobs: jest.fn().mockResolvedValue([]),
            retryDeadLetterJob: jest.fn().mockResolvedValue({ success: true, message: 'retried' }),
          },
        },
        {
          provide: JobFailureService,
          useValue: {
            retryById: jest.fn(),
            bulkRetry: jest.fn(),
          },
        },
        {
          provide: PoisonMessageDetectorService,
          useValue: {
            getAllPoisonCandidates: jest.fn().mockReturnValue([]),
            getPoisonStatus: jest.fn().mockReturnValue(undefined),
            clearJob: jest.fn(),
          },
        },
        {
          provide: DeadLetterAlertingService,
          useValue: {
            getAllVolumeStates: jest.fn().mockReturnValue([]),
          },
        },
        {
          provide: CircuitBreakerAwareBackoffService,
          useValue: {
            getAllDownstreamStates: jest.fn().mockReturnValue([]),
            resetDownstream: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            createLog: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    controller = module.get(QueueAdminController);
    queueService = module.get(QueueService) as jest.Mocked<QueueService>;
    jobFailureService = module.get(JobFailureService) as jest.Mocked<JobFailureService>;
    auditService = module.get(AuditService) as jest.Mocked<AuditService>;
    poisonDetector = module.get(PoisonMessageDetectorService) as jest.Mocked<PoisonMessageDetectorService>;
    alertingService = module.get(DeadLetterAlertingService) as jest.Mocked<DeadLetterAlertingService>;
    backoffService = module.get(CircuitBreakerAwareBackoffService) as jest.Mocked<CircuitBreakerAwareBackoffService>;
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // getStats()
  // -------------------------------------------------------------------------
  describe('getStats()', () => {
    it('should return queue stats from QueueService', async () => {
      const result = await controller.getStats();
      expect(result).toBe(mockStats);
      expect(queueService.getStats).toHaveBeenCalledTimes(1);
    });

    it('should return an object with queues array and deadLetter', async () => {
      const result = await controller.getStats();
      expect(result.queues).toHaveLength(3);
      expect(result.deadLetter).toBeDefined();
      expect(result.retrievedAt).toBeDefined();
    });

    it('should propagate service errors', async () => {
      queueService.getStats.mockRejectedValueOnce(new Error('Redis down'));
      await expect(controller.getStats()).rejects.toThrow('Redis down');
    });
  });

  // -------------------------------------------------------------------------
  // getPoisonMessages()
  // -------------------------------------------------------------------------
  describe('getPoisonMessages()', () => {
    it('should return poison-message candidates with total', async () => {
      poisonDetector.getAllPoisonCandidates.mockReturnValue([{ jobId: 'job-1', signature: { consecutiveFailures: 3 } as any }]);

      const result = await controller.getPoisonMessages();
      expect(result).toMatchObject({ success: true, data: [{ jobId: 'job-1' }], total: 1 });
    });

    it('should return empty list when no candidates', async () => {
      const result = await controller.getPoisonMessages();
      expect(result).toEqual({ success: true, data: [], total: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // getPoisonMessageStatus()
  // -------------------------------------------------------------------------
  describe('getPoisonMessageStatus()', () => {
    it('should return poison-message status for a job', async () => {
      const status = { consecutiveFailures: 3, signature: 'sig', errorClass: 'Error' };
      poisonDetector.getPoisonStatus.mockReturnValue(status as any);

      const result = await controller.getPoisonMessageStatus('job-1');
      expect(result).toEqual({ success: true, data: status });
    });

    it('should throw NotFoundException when job not tracked', async () => {
      await expect(controller.getPoisonMessageStatus('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // clearPoisonMessage()
  // -------------------------------------------------------------------------
  describe('clearPoisonMessage()', () => {
    it('should clear poison-message tracking and audit', async () => {
      const result = await controller.clearPoisonMessage('job-1', adminRequest);

      expect(poisonDetector.clearJob).toHaveBeenCalledWith('job-1');
      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-user-uuid',
          action: 'ADMIN_POISON_MESSAGE_CLEAR',
          metadata: { jobId: 'job-1' },
        }),
      );
      expect(result).toEqual({ success: true, message: expect.any(String) });
    });
  });

  // -------------------------------------------------------------------------
  // getDeadLetterVolume()
  // -------------------------------------------------------------------------
  describe('getDeadLetterVolume()', () => {
    it('should return dead-letter volume states', async () => {
      alertingService.getAllVolumeStates.mockReturnValue([
        { queueName: 'email-queue', state: { count: 5 } as any },
      ]);

      const result = await controller.getDeadLetterVolume();
      expect(result).toMatchObject({
        success: true,
        data: [{ queueName: 'email-queue' }],
        total: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getBackoffStates()
  // -------------------------------------------------------------------------
  describe('getBackoffStates()', () => {
    it('should return backoff states', async () => {
      backoffService.getAllDownstreamStates.mockReturnValue([
        { downstream: 'stellar-rpc', currentDelayMs: 5000 } as any,
      ]);

      const result = await controller.getBackoffStates();
      expect(result).toMatchObject({
        success: true,
        data: [{ downstream: 'stellar-rpc' }],
        total: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // resetBackoffState()
  // -------------------------------------------------------------------------
  describe('resetBackoffState()', () => {
    it('should reset backoff state and audit', async () => {
      const result = await controller.resetBackoffState('stellar-rpc', adminRequest);

      expect(backoffService.resetDownstream).toHaveBeenCalledWith('stellar-rpc');
      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ADMIN_BACKOFF_STATE_RESET',
          metadata: { downstream: 'stellar-rpc' },
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/dead-letter/:id/retry
  // -------------------------------------------------------------------------
  describe('retryDeadLetterJob()', () => {
    const recordId = 'record-uuid-1';
    const mockedRecord = {
      id: recordId,
      jobId: 'original-job-id',
      jobName: 'send-email',
      queueName: QUEUE_NAMES.EMAIL,
      error: 'Timeout',
      stackTrace: null,
      attemptNumber: 3,
      data: { to: 'a@b.com' },
      retryCount: 1,
      status: 'RETRYING' as const,
      failedAt: new Date(),
      updatedAt: new Date(),
      lastRetriedAt: new Date(),
      isPoison: false,
      consecutiveFailures: 0,
      failureSignature: null,
      errorClass: 'Error',
    };

    it('should re-enqueue the job and return success', async () => {
      jobFailureService.retryById.mockResolvedValueOnce({
        record: mockedRecord,
        enqueuedJobId: 'new-job-42',
      });

      const result = await controller.retryDeadLetterJob(recordId, adminRequest);

      expect(jobFailureService.retryById).toHaveBeenCalledWith(recordId);
      expect(result).toMatchObject({
        success: true,
        recordId,
        enqueuedJobId: 'new-job-42',
        status: 'RETRYING',
        retryCount: 1,
      });
    });

    it('should write an audit log entry', async () => {
      jobFailureService.retryById.mockResolvedValueOnce({
        record: mockedRecord,
        enqueuedJobId: 'new-job-42',
      });

      await controller.retryDeadLetterJob(recordId, adminRequest);

      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-user-uuid',
          action: 'ADMIN_DEAD_LETTER_RETRY',
          resource: 'job_failures',
          metadata: expect.objectContaining({
            recordId,
            queueName: QUEUE_NAMES.EMAIL,
            enqueuedJobId: 'new-job-42',
          }),
        }),
      );
    });

    it('should throw NotFoundException when record not found', async () => {
      jobFailureService.retryById.mockRejectedValueOnce(
        new Error('Could not find any entity of type "JobFailure"'),
      );
      await expect(
        controller.retryDeadLetterJob('non-existent-id', adminRequest),
      ).rejects.toThrow(NotFoundException);
    });

    it('should propagate unknown errors', async () => {
      jobFailureService.retryById.mockRejectedValueOnce(new Error('Unknown queue: bad-queue'));
      await expect(
        controller.retryDeadLetterJob(recordId, adminRequest),
      ).rejects.toThrow('Unknown queue: bad-queue');
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/dead-letter/bulk-retry
  // -------------------------------------------------------------------------
  describe('bulkRetryDeadLetterJobs()', () => {
    const bulkResult = {
      results: [
        { id: 'id-1', success: true },
        { id: 'id-2', success: true },
        { id: 'id-3', success: false, error: 'Unknown queue' },
      ],
      total: 3,
    };

    it('should bulk retry by array of IDs', async () => {
      jobFailureService.bulkRetry.mockResolvedValueOnce(bulkResult);

      const dto = { ids: ['id-1', 'id-2', 'id-3'] };
      const result = await controller.bulkRetryDeadLetterJobs(dto, adminRequest);

      expect(jobFailureService.bulkRetry).toHaveBeenCalledWith(dto);
      expect(result.total).toBe(3);
      expect(result.results).toHaveLength(3);
    });

    it('should bulk retry by filter', async () => {
      jobFailureService.bulkRetry.mockResolvedValueOnce(bulkResult);

      const dto = {
        queueName: QUEUE_NAMES.EMAIL,
        createdBefore: '2025-01-01T00:00:00.000Z',
      };
      const result = await controller.bulkRetryDeadLetterJobs(dto, adminRequest);

      expect(jobFailureService.bulkRetry).toHaveBeenCalledWith(dto);
      expect(result).toEqual(bulkResult);
    });

    it('should emit an audit log for bulk retry', async () => {
      jobFailureService.bulkRetry.mockResolvedValueOnce(bulkResult);

      const dto = { ids: ['id-1', 'id-2'] };
      await controller.bulkRetryDeadLetterJobs(dto, adminRequest);

      expect(auditService.createLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-user-uuid',
          action: 'ADMIN_DEAD_LETTER_BULK_RETRY',
          resource: 'job_failures',
          metadata: expect.objectContaining({
            filter: dto,
            total: 3,
            succeeded: 2,
            failed: 1,
          }),
        }),
      );
    });

    it('should propagate service errors during bulk retry', async () => {
      jobFailureService.bulkRetry.mockRejectedValueOnce(new Error('DB error'));
      await expect(
        controller.bulkRetryDeadLetterJobs({ ids: ['id-1'] }, adminRequest),
      ).rejects.toThrow('DB error');
    });
  });
});