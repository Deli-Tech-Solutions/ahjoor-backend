import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { RedisThrottlerStorageService } from './redis-throttler-storage.service';
import { RedisService } from '../common/redis/redis.service';

describe('RedisThrottlerStorageService', () => {
  let service: RedisThrottlerStorageService;
  let redisMock: {
    eval: jest.Mock;
    pttl: jest.Mock;
  };

  beforeEach(async () => {
    process.env.THROTTLE_ALGORITHM = 'fixed_window';
    redisMock = {
      eval: jest.fn(),
      pttl: jest.fn().mockResolvedValue(-2),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisThrottlerStorageService,
        {
          provide: RedisService,
          useValue: { getClient: () => redisMock },
        },
      ],
    }).compile();

    service = module.get(RedisThrottlerStorageService);
  });

  afterEach(() => {
    delete process.env.THROTTLE_ALGORITHM;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('increment (Nest v6 contract)', () => {
    it('returns isBlocked=false when under limit', async () => {
      redisMock.eval.mockResolvedValue([3, 60000]);

      const result = await service.increment('k', 60000, 10, 60000, 'default');

      expect(result.isBlocked).toBe(false);
      expect(result.totalHits).toBe(3);
      expect(result.timeToExpire).toBe(60);
      expect(redisMock.eval).toHaveBeenCalled();
    });

    it('returns isBlocked=true when totalHits exceeds limit', async () => {
      redisMock.eval
        .mockResolvedValueOnce([11, 45000]) // fixed window
        .mockResolvedValueOnce(45000); // block lua

      const result = await service.increment('k', 60000, 10, 60000, 'default');

      expect(result.isBlocked).toBe(true);
      expect(result.totalHits).toBe(11);
      expect(result.timeToBlockExpire).toBeGreaterThan(0);
    });

    it('fail-closes with 503 when Redis throws', async () => {
      redisMock.pttl.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.increment('k', 60000, 10, 60000, 'default'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('respects an existing block key without incrementing further', async () => {
      redisMock.pttl.mockResolvedValue(30000);

      const result = await service.increment('k', 60000, 10, 60000, 'default');

      expect(result.isBlocked).toBe(true);
      expect(redisMock.eval).not.toHaveBeenCalled();
    });
  });
});
