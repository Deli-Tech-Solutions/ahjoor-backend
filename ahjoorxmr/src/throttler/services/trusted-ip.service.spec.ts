import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TrustedIpService } from './trusted-ip.service';
import { RedisService } from '../../common/redis/redis.service';

describe('TrustedIpService', () => {
  let service: TrustedIpService;
  let mockRedis: Record<string, jest.Mock>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockRedis = {
      setex: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
      keys: jest.fn(),
      eval: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === 'TRUSTED_IPS') {
          return '127.0.0.1,10.0.0.1';
        }
        if (key === 'TRUSTED_IP_RANGES') {
          return '192.168.1.1-192.168.1.255';
        }
        return defaultValue;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrustedIpService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: RedisService,
          useValue: { getClient: () => mockRedis },
        },
      ],
    }).compile();

    service = module.get<TrustedIpService>(TrustedIpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('isTrustedIp', () => {
    it('should return true for exact match in trusted list', () => {
      expect(service.isTrustedIp('127.0.0.1')).toBe(true);
      expect(service.isTrustedIp('10.0.0.1')).toBe(true);
    });

    it('should return true for IP in trusted range', () => {
      expect(service.isTrustedIp('192.168.1.100')).toBe(true);
    });

    it('should return false for untrusted IP', () => {
      expect(service.isTrustedIp('8.8.8.8')).toBe(false);
    });

    it('should return false for invalid IP', () => {
      expect(service.isTrustedIp('')).toBe(false);
    });
  });

  describe('addTrustedIp', () => {
    it('should add IP to trusted list without TTL', async () => {
      await service.addTrustedIp('1.2.3.4');
      expect(mockRedis.set).toHaveBeenCalledWith('trusted_ip:1.2.3.4', '1');
      expect(service.isTrustedIp('1.2.3.4')).toBe(true);
    });

    it('should add IP with TTL via setex', async () => {
      await service.addTrustedIp('1.2.3.4', 60);
      expect(mockRedis.setex).toHaveBeenCalledWith('trusted_ip:1.2.3.4', 60, '1');
    });
  });

  describe('incrementViolations', () => {
    it('uses atomic Lua INCR+EXPIRE', async () => {
      mockRedis.eval.mockResolvedValue(2);
      const result = await service.incrementViolations('9.9.9.9', 5, 3600);
      expect(mockRedis.eval).toHaveBeenCalled();
      expect(result.count).toBe(2);
      expect(result.shouldBlock).toBe(false);
    });

    it('blocks when threshold reached', async () => {
      mockRedis.eval.mockResolvedValue(5);
      mockRedis.setex.mockResolvedValue('OK');
      const result = await service.incrementViolations('9.9.9.9', 5, 3600);
      expect(result.shouldBlock).toBe(true);
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });
});
