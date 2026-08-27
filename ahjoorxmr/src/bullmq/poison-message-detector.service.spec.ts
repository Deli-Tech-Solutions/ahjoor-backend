import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PoisonMessageDetectorService } from './poison-message-detector.service';

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      POISON_MESSAGE_THRESHOLD: 3,
      POISON_MESSAGE_SIGNATURE_TTL_MS: 30 * 60 * 1000,
      POISON_MESSAGE_MAX_TRACKER_ENTRIES: 10000,
    };
    return config[key] ?? defaultValue;
  }),
};

const makeJob = (id: string, data: unknown): Job =>
  ({
    id,
    name: 'test-job',
    data,
  }) as unknown as Job;

describe('PoisonMessageDetectorService', () => {
  let service: PoisonMessageDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PoisonMessageDetectorService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get(PoisonMessageDetectorService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    service.reset();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recordFailure()', () => {
    it('should not flag first failure as poison', () => {
      const job = makeJob('job-1', { to: 'a@b.com' });
      const result = service.recordFailure(job, new Error('SMTP error'));

      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(1);
    });

    it('should flag poison after consecutive failures with same signature', () => {
      const job = makeJob('job-1', { to: 'a@b.com' });
      const error = new Error('Malformed payload');

      // First failure
      let result = service.recordFailure(job, error);
      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(1);

      // Second failure with same error + payload
      result = service.recordFailure(job, error);
      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(2);

      // Third failure with same error + payload → poison
      result = service.recordFailure(job, error);
      expect(result.isPoison).toBe(true);
      expect(result.consecutiveFailures).toBe(3);
    });

    it('should not flag when error class changes', () => {
      const job = makeJob('job-2', { to: 'a@b.com' });

      service.recordFailure(job, new Error('Timeout'));
      const result = service.recordFailure(job, new TypeError('Type error'));

      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(1);
    });

    it('should not flag when payload changes', () => {
      const job1 = makeJob('job-3', { to: 'a@b.com' });
      const job2 = makeJob('job-3', { to: 'different@b.com' });
      const error = new Error('Some error');

      service.recordFailure(job1, error);
      const result = service.recordFailure(job2, error);

      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(1);
    });

    it('should generate identical signatures for objects with different key order', () => {
      const job1 = makeJob('job-4', { a: 1, b: 2 });
      const job2 = makeJob('job-4', { b: 2, a: 1 });

      service.recordFailure(job1, new Error('Error'));
      const result = service.recordFailure(job2, new Error('Error'));

      expect(result.isPoison).toBe(false);
      expect(result.consecutiveFailures).toBe(2);
    });
  });

  describe('getPoisonStatus()', () => {
    it('should return status for tracked job', () => {
      const job = makeJob('job-5', { data: 'test' });
      service.recordFailure(job, new Error('Error'));

      const status = service.getPoisonStatus('job-5');
      expect(status).toBeDefined();
      expect(status?.consecutiveFailures).toBe(1);
    });

    it('should return undefined for untracked job', () => {
      expect(service.getPoisonStatus('unknown')).toBeUndefined();
    });
  });

  describe('clearJob()', () => {
    it('should remove job from tracker', () => {
      const job = makeJob('job-6', { data: 'test' });
      service.recordFailure(job, new Error('Error'));

      service.clearJob('job-6');
      expect(service.getPoisonStatus('job-6')).toBeUndefined();
    });
  });

  describe('getAllPoisonCandidates()', () => {
    it('should return only jobs that have reached the threshold', () => {
      const job = makeJob('job-7', { data: 'test' });
      const error = new Error('Malformed');

      // Reach poison threshold
      for (let i = 0; i < 3; i++) {
        service.recordFailure(job, error);
      }

      // Another job below threshold
      const otherJob = makeJob('job-8', { data: 'other' });
      service.recordFailure(otherJob, new Error('Other'));

      const candidates = service.getAllPoisonCandidates();
      expect(candidates).toHaveLength(1);
      expect(candidates[0].jobId).toBe('job-7');
    });
  });

  describe('reset()', () => {
    it('should clear all entries', () => {
      const job = makeJob('job-9', { data: 'test' });
      service.recordFailure(job, new Error('Error'));

      service.reset();
      expect(service.getPoisonStatus('job-9')).toBeUndefined();
    });
  });
});