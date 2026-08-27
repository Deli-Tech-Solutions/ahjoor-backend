import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueService } from './queue.service';
import { QUEUE_NAMES, JOB_NAMES } from './queue.constants';
import { CircuitBreakerAwareBackoffService } from './circuit-breaker-aware-backoff.service';

// Factory to create a full mock Queue
function makeMockQueue(name: string): jest.Mocked<Queue> {
  return {
    name,
    add: jest.fn().mockResolvedValue({ id: `${name}-job-id` }),
    getWaitingCount: jest.fn().mockResolvedValue(5),
    getActiveCount: jest.fn().mockResolvedValue(2),
    getCompletedCount: jest.fn().mockResolvedValue(100),
    getFailedCount: jest.fn().mockResolvedValue(3),
    getDelayedCount: jest.fn().mockResolvedValue(0),
    isPaused: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<Queue>;
}

const mockBackoffService = {
  getBackoffDelay: jest.fn().mockReturnValue(5000),
  recordFailure: jest.fn(),
  recordSuccess: jest.fn(),
};

describe('QueueService', () => {
  let service: QueueService;
  let emailQueue: jest.Mocked<Queue>;
  let eventSyncQueue: jest.Mocked<Queue>;
  let groupSyncQueue: jest.Mocked<Queue>;
  let payoutReconciliationQueue: jest.Mocked<Queue>;
  let deadLetterQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    emailQueue = makeMockQueue(QUEUE_NAMES.EMAIL);
    eventSyncQueue = makeMockQueue(QUEUE_NAMES.EVENT_SYNC);
    groupSyncQueue = makeMockQueue(QUEUE_NAMES.GROUP_SYNC);
    payoutReconciliationQueue = makeMockQueue(
      QUEUE_NAMES.PAYOUT_RECONCILIATION,
    );
    deadLetterQueue = makeMockQueue(QUEUE_NAMES.DEAD_LETTER);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: emailQueue },
        {
          provide: getQueueToken(QUEUE_NAMES.EVENT_SYNC),
          useValue: eventSyncQueue,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.GROUP_SYNC),
          useValue: groupSyncQueue,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.PAYOUT_RECONCILIATION),
          useValue: payoutReconciliationQueue,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.DEAD_LETTER),
          useValue: deadLetterQueue,
        },
        {
          provide: getQueueToken(QUEUE_NAMES.TX_CONFIRMATION),
          useValue: makeMockQueue(QUEUE_NAMES.TX_CONFIRMATION),
        },
        {
          provide: getQueueToken(QUEUE_NAMES.PUSH_NOTIFICATION),
          useValue: makeMockQueue(QUEUE_NAMES.PUSH_NOTIFICATION),
        },
        {
          provide: getQueueToken(QUEUE_NAMES.TRUST_SCORE),
          useValue: makeMockQueue(QUEUE_NAMES.TRUST_SCORE),
        },
        {
          provide: CircuitBreakerAwareBackoffService,
          useValue: mockBackoffService,
        },
      ],
    }).compile();

    service = module.get(QueueService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Email
  // ---------------------------------------------------------------------------
  describe('email queue', () => {
    const emailData = { to: 'user@example.com', subject: 'Test' };

    it('addSendEmail should call emailQueue.add with correct job name', async () => {
      await service.addSendEmail(emailData);
      expect(emailQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SEND_EMAIL,
        emailData,
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('addSendNotificationEmail should call emailQueue.add', async () => {
      const data = {
        ...emailData,
        userId: 'u1',
        notificationType: 'INVITE',
        body: 'You have been invited',
      };
      await service.addSendNotificationEmail(data);
      expect(emailQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SEND_NOTIFICATION_EMAIL,
        data,
        expect.any(Object),
      );
    });

    it('addSendWelcomeEmail should call emailQueue.add', async () => {
      const data = { userId: 'u1', email: 'a@b.com', username: 'Alice' };
      await service.addSendWelcomeEmail(data);
      expect(emailQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SEND_WELCOME_EMAIL,
        data,
        expect.any(Object),
      );
    });

    it('should pass custom job options through', async () => {
      await service.addSendEmail(emailData, { priority: 1 });
      const [, , opts] = emailQueue.add.mock.calls[0];
      expect(opts).toMatchObject({ attempts: 3, priority: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // Event sync
  // ---------------------------------------------------------------------------
  describe('event sync queue', () => {
    const onChainData = {
      eventName: 'Transfer',
      transactionHash: '0xabc',
      blockNumber: 1,
      contractAddress: '0xc',
      logIndex: 0,
      rawData: {},
      chainId: 1,
    };

    it('addSyncOnChainEvent should call eventSyncQueue.add', async () => {
      await service.addSyncOnChainEvent(onChainData);
      expect(eventSyncQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SYNC_ON_CHAIN_EVENT,
        onChainData,
        expect.any(Object),
      );
    });

    it('addProcessTransferEvent should call eventSyncQueue.add', async () => {
      const data = {
        from: '0xa',
        to: '0xb',
        amount: '1',
        transactionHash: '0xtx',
        blockNumber: 2,
        tokenAddress: '0xt',
        chainId: 1,
      };
      await service.addProcessTransferEvent(data);
      expect(eventSyncQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PROCESS_TRANSFER_EVENT,
        data,
        expect.any(Object),
      );
    });

    it('addProcessApprovalEvent should call eventSyncQueue.add', async () => {
      const data = {
        owner: '0xo',
        spender: '0xs',
        amount: '100',
        transactionHash: '0xtx',
        blockNumber: 3,
        tokenAddress: '0xt',
        chainId: 1,
      };
      await service.addProcessApprovalEvent(data);
      expect(eventSyncQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.PROCESS_APPROVAL_EVENT,
        data,
        expect.any(Object),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Group sync
  // ---------------------------------------------------------------------------
  describe('group sync queue', () => {
    it('addSyncGroupState should call groupSyncQueue.add', async () => {
      const data = { groupId: 'g1', contractAddress: '0xc', chainId: 8453 };
      await service.addSyncGroupState(data);
      expect(groupSyncQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SYNC_GROUP_STATE,
        expect.objectContaining({ groupId: 'g1' }),
        expect.objectContaining({ jobId: 'g1' }),
      );
    });

    it('addSyncAllGroups should call groupSyncQueue.add', async () => {
      const data = { chainId: 8453, batchSize: 100 };
      await service.addSyncAllGroups(data);
      expect(groupSyncQueue.add).toHaveBeenCalledWith(
        JOB_NAMES.SYNC_ALL_GROUPS,
        data,
        expect.any(Object),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------
  describe('getStats()', () => {
    it('should return stats for all queues', async () => {
      const result = await service.getStats();

      expect(result.queues).toHaveLength(4);
      expect(result.deadLetter).toBeDefined();
      expect(result.retrievedAt).toBeDefined();

      const emailStats = result.queues.find(
        (q) => q.name === QUEUE_NAMES.EMAIL,
      );
      expect(emailStats).toMatchObject({
        name: QUEUE_NAMES.EMAIL,
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 0,
        paused: 0,
      });
    });

    it('should call count methods on all queues', async () => {
      await service.getStats();

      for (const queue of [
        emailQueue,
        eventSyncQueue,
        groupSyncQueue,
        payoutReconciliationQueue,
        deadLetterQueue,
      ]) {
        expect(queue.getWaitingCount).toHaveBeenCalled();
        expect(queue.getActiveCount).toHaveBeenCalled();
        expect(queue.getFailedCount).toHaveBeenCalled();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getQueues()
  // ---------------------------------------------------------------------------
  describe('getQueues()', () => {
    it('should return all queues', () => {
      const queues = service.getQueues();
      expect(queues).toHaveLength(7);
      expect(queues.map((q) => q.name)).toEqual([
        QUEUE_NAMES.EMAIL,
        QUEUE_NAMES.EVENT_SYNC,
        QUEUE_NAMES.GROUP_SYNC,
        QUEUE_NAMES.PAYOUT_RECONCILIATION,
        QUEUE_NAMES.DEAD_LETTER,
        QUEUE_NAMES.TX_CONFIRMATION,
        QUEUE_NAMES.PUSH_NOTIFICATION,
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Circuit-breaker-aware backoff
  // ---------------------------------------------------------------------------
  describe('circuit-breaker-aware backoff', () => {
    it('getBackoffDelay should delegate to backoff service', () => {
      service.getBackoffDelay('stellar-rpc', 2);
      expect(mockBackoffService.getBackoffDelay).toHaveBeenCalledWith(
        'stellar-rpc',
        2,
      );
    });

    it('recordBackoffFailure should delegate to backoff service', () => {
      const error = new Error('RPC timeout');
      service.recordBackoffFailure('stellar-rpc', error);
      expect(mockBackoffService.recordFailure).toHaveBeenCalledWith(
        'stellar-rpc',
        error,
      );
    });

    it('recordBackoffSuccess should delegate to backoff service', () => {
      service.recordBackoffSuccess('stellar-rpc');
      expect(mockBackoffService.recordSuccess).toHaveBeenCalledWith(
        'stellar-rpc',
      );
    });
  });
});