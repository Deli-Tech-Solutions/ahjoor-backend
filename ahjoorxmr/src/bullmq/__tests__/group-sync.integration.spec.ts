/**
 * Integration Tests — Group Mediation Distributed Locking
 *
 * Covers the full acceptance criteria from issue #163:
 *   1. Two concurrent mediation triggers for the same group → one PROCESSED, one SKIPPED
 *   2. BullMQ jobId deduplication: addSyncGroupState called twice → only one job enqueued
 *   3. Bulk dispatch (handleSyncAllGroups) includes jobId on each job
 *   4. SYNC_ALL_GROUPS routing is unaffected — no mediation lock acquired during batch dispatch
 *   5. Lock is released exactly once (only the lock-holder releases)
 *
 * Uses mocked RedlockService to simulate real lock contention without a live Redis instance.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Job, JobsOptions } from 'bullmq';
import { GroupSyncProcessor } from '../group-sync.processor';
import { QueueService } from '../queue.service';
import { DeadLetterService } from '../dead-letter.service';
import { CircuitBreakerAwareBackoffService } from '../circuit-breaker-aware-backoff.service';
import { StellarService } from '../../stellar/stellar.service';
import { Group } from '../../groups/entities/group.entity';
import { GroupStatus } from '../../groups/entities/group-status.enum';
import { JOB_NAMES, QUEUE_NAMES } from '../queue.constants';
import { RedlockService } from '../../common/redis/redlock.service';
import { ConfigService } from '@nestjs/config';

const makeJob = (name: string, data: unknown): Job =>
  ({
    id: `integration-job-${Math.random()}`,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as unknown as Job;

describe('Integration: Group Mediation Distributed Locking (#163)', () => {
  let processor: GroupSyncProcessor;
  let groupRepo: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock };
  let redlockService: { acquire: jest.Mock; release: jest.Mock };
  let stellarService: { getGroupState: jest.Mock };
  let groupSyncQueue: { add: jest.Mock; addBulk: jest.Mock };

  const GROUP_ID = 'integration-group-uuid';
  const CONTRACT = '0xintegration-contract';

  const activeGroup: Partial<Group> = {
    id: GROUP_ID,
    contractAddress: CONTRACT,
    status: GroupStatus.ACTIVE,
    currentRound: 2,
    staleAt: null,
  };

  beforeEach(async () => {
    groupRepo = { findOne: jest.fn(), save: jest.fn(), find: jest.fn() };
    stellarService = { getGroupState: jest.fn() };
    groupSyncQueue = {
      add: jest.fn().mockResolvedValue({ id: GROUP_ID }),
      addBulk: jest.fn().mockResolvedValue([]),
    };

    // Default: lock always available
    const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
    redlockService = {
      acquire: jest.fn().mockResolvedValue(mockLock),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupSyncProcessor,
        QueueService,
        { provide: DeadLetterService, useValue: { moveToDeadLetter: jest.fn() } },
        { provide: StellarService, useValue: stellarService },
        { provide: RedlockService, useValue: redlockService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, def: string) => def) },
        },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getQueueToken(QUEUE_NAMES.GROUP_SYNC), useValue: groupSyncQueue },
        // Stub other queues required by QueueService
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: { add: jest.fn() } },
        { provide: getQueueToken(QUEUE_NAMES.EVENT_SYNC), useValue: { add: jest.fn() } },
        {
          provide: getQueueToken(QUEUE_NAMES.PAYOUT_RECONCILIATION),
          useValue: { add: jest.fn() },
        },
        { provide: getQueueToken(QUEUE_NAMES.DEAD_LETTER), useValue: { add: jest.fn() } },
        {
          provide: CircuitBreakerAwareBackoffService,
          useValue: {
            getBackoffDelay: jest.fn().mockReturnValue(5000),
            recordFailure: jest.fn(),
            recordSuccess: jest.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get(GroupSyncProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  // ── AC1: Two concurrent triggers → one PROCESSED, one SKIPPED ────────────

  it('AC1: two concurrent mediation triggers for the same group → one PROCESSED, one SKIPPED', async () => {
    // Simulate real lock contention: first acquire succeeds, second returns null
    let lockHeld = false;
    const mockLock = { release: jest.fn().mockResolvedValue(undefined) };

    redlockService.acquire.mockImplementation(async () => {
      if (lockHeld) return null;
      lockHeld = true;
      return mockLock;
    });
    redlockService.release.mockImplementation(async () => {
      lockHeld = false;
    });

    // Slow mediation body ensures both calls truly overlap
    groupRepo.findOne.mockResolvedValue({ ...activeGroup });
    stellarService.getGroupState.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ current_round: 3, status: 'ACTIVE' }), 40),
        ),
    );
    groupRepo.save.mockResolvedValue({});

    const jobData = { groupId: GROUP_ID, contractAddress: CONTRACT, chainId: 1 };
    const [r1, r2] = await Promise.all([
      processor.process(makeJob(JOB_NAMES.SYNC_GROUP_STATE, jobData)),
      processor.process(makeJob(JOB_NAMES.SYNC_GROUP_STATE, jobData)),
    ]);

    const results = [r1, r2] as Array<{ status: string }>;

    // Exactly one PROCESSED, exactly one SKIPPED
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'SKIPPED')).toHaveLength(1);

    // No duplicate state transitions
    expect(groupRepo.save).toHaveBeenCalledTimes(1);

    // Only the lock-holder releases
    expect(redlockService.release).toHaveBeenCalledTimes(1);
  });

  // ── AC2: BullMQ jobId deduplication via QueueService ─────────────────────

  it('AC2: addSyncGroupState passes jobId=groupId to prevent duplicate enqueues', async () => {
        const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: { add: jest.fn() } },
        { provide: getQueueToken(QUEUE_NAMES.EVENT_SYNC), useValue: { add: jest.fn() } },
        { provide: getQueueToken(QUEUE_NAMES.GROUP_SYNC), useValue: groupSyncQueue },
        {
          provide: getQueueToken(QUEUE_NAMES.PAYOUT_RECONCILIATION),
          useValue: { add: jest.fn() },
        },
        { provide: getQueueToken(QUEUE_NAMES.DEAD_LETTER), useValue: { add: jest.fn() } },
        {
          provide: CircuitBreakerAwareBackoffService,
          useValue: {
            getBackoffDelay: jest.fn().mockReturnValue(5000),
            recordFailure: jest.fn(),
            recordSuccess: jest.fn(),
          },
        },
      ],
    }).compile();

    const queueService = module.get(QueueService);
    const jobData = { groupId: GROUP_ID, contractAddress: CONTRACT, chainId: 1 };

    await queueService.addSyncGroupState(jobData);

    expect(groupSyncQueue.add).toHaveBeenCalledWith(
      JOB_NAMES.SYNC_GROUP_STATE,
      jobData,
      expect.objectContaining({ jobId: GROUP_ID }),
    );
  });

  // ── AC3: Bulk dispatch includes jobId on each job ─────────────────────────

  it('AC3: handleSyncAllGroups bulk dispatch includes jobId on each job for deduplication', async () => {
    const groups = [
      { id: 'bulk-g1', contractAddress: '0xbulk1' },
      { id: 'bulk-g2', contractAddress: '0xbulk2' },
    ];
    groupRepo.find
      .mockResolvedValueOnce(groups)
      .mockResolvedValueOnce([]); // second page empty

    await processor.process(
      makeJob(JOB_NAMES.SYNC_ALL_GROUPS, { chainId: 1, batchSize: 50 }),
    );

    expect(groupSyncQueue.addBulk).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: JOB_NAMES.SYNC_GROUP_STATE,
          data: expect.objectContaining({ groupId: 'bulk-g1' }),
          opts: expect.objectContaining({ jobId: 'bulk-g1' }),
        }),
        expect.objectContaining({
          name: JOB_NAMES.SYNC_GROUP_STATE,
          data: expect.objectContaining({ groupId: 'bulk-g2' }),
          opts: expect.objectContaining({ jobId: 'bulk-g2' }),
        }),
      ]),
    );
  });

  // ── AC4: SYNC_ALL_GROUPS routing unaffected — no mediation lock ───────────

  it('AC4: SYNC_ALL_GROUPS job does not acquire mediation lock — only dispatches batch jobs', async () => {
    groupRepo.find
      .mockResolvedValueOnce([{ id: 'g1', contractAddress: '0xc1' }])
      .mockResolvedValueOnce([]);

    await processor.process(
      makeJob(JOB_NAMES.SYNC_ALL_GROUPS, { chainId: 1 }),
    );

    expect(groupSyncQueue.addBulk).toHaveBeenCalled();
    expect(redlockService.acquire).not.toHaveBeenCalled();
  });

  // ── AC5: Lock released on error path ─────────────────────────────────────

  it('AC5: lock is released in finally block when mediation body throws', async () => {
    const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
    redlockService.acquire.mockResolvedValue(mockLock);

    groupRepo.findOne.mockResolvedValue({ ...activeGroup });
    stellarService.getGroupState.mockRejectedValue(new Error('stellar rpc timeout'));

    const jobData = { groupId: GROUP_ID, contractAddress: CONTRACT, chainId: 1 };

    await expect(
      processor.process(makeJob(JOB_NAMES.SYNC_GROUP_STATE, jobData)),
    ).rejects.toThrow('stellar rpc timeout');

    // Lock released despite the error
    expect(redlockService.release).toHaveBeenCalledWith(mockLock);
    expect(redlockService.release).toHaveBeenCalledTimes(1);

    // No partial state saved
    expect(groupRepo.save).not.toHaveBeenCalled();
  });

  // ── AC6: Lock TTL configurable via MEDIATION_LOCK_TTL_MS ─────────────────

  it('AC6: lock TTL defaults to 30000ms and is configurable via MEDIATION_LOCK_TTL_MS', async () => {
    const mockLock = { release: jest.fn().mockResolvedValue(undefined) };
    redlockService.acquire.mockResolvedValue(mockLock);
    groupRepo.findOne.mockResolvedValue({ ...activeGroup });
    stellarService.getGroupState.mockResolvedValue({ current_round: 2, status: 'ACTIVE' });

    const jobData = { groupId: GROUP_ID, contractAddress: CONTRACT, chainId: 1 };
    await processor.process(makeJob(JOB_NAMES.SYNC_GROUP_STATE, jobData));

    // Default TTL is 30000ms (Math.ceil(25000 * 1.2))
    expect(redlockService.acquire).toHaveBeenCalledWith(
      `mediation:group:${GROUP_ID}`,
      30000,
    );
  });
});
