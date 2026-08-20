import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerAwareBackoffService } from './circuit-breaker-aware-backoff.service';
import { StellarCircuitBreakerService } from '../stellar/stellar-circuit-breaker.service';

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      CIRCUIT_BREAKER_BASE_BACKOFF_MS: 5000,
      CIRCUIT_BREAKER_MAX_BACKOFF_MS: 300000,
      CIRCUIT_BREAKER_BACKOFF_MULTIPLIER: 2,
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
    };
    return config[key] ?? defaultValue;
  }),
};

const mockCircuitBreaker = {
  isOpen: jest.fn().mockReturnValue(false),
  getState: jest.fn().mockReturnValue({
    failures: 0,
    lastFailureAt: Date.now() - 1000,
    isOpen: false,
    lastHalfOpenProbeAt: null,
  }),
};

describe('CircuitBreakerAwareBackoffService', () => {
  let service: CircuitBreakerAwareBackoffService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircuitBreakerAwareBackoffService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: StellarCircuitBreakerService, useValue: mockCircuitBreaker },
      ],
    }).compile();

    service = module.get(CircuitBreakerAwareBackoffService);
  });

  afterEach(() => {
    service.resetAll();
    mockCircuitBreaker.isOpen.mockReturnValue(false);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBackoffDelay()', () => {
    it('should use exponential backoff for no active state', () => {
      const delay = service.getBackoffDelay('mail-provider', 0);
      expect(delay).toBe(5000);

      const delay1 = service.getBackoffDelay('mail-provider', 1);
      expect(delay1).toBe(10000);

      const delay2 = service.getBackoffDelay('mail-provider', 2);
      expect(delay2).toBe(20000);
    });

    it('should return remaining time from shared state if available', () => {
      service.recordFailure('mail-provider', new Error('Failure'));
      const delay = service.getBackoffDelay('mail-provider', 0);

      // Should be the remaining time, which is close to 5000ms
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(5000);
    });

    it('should use longer backoff when stellar circuit is open', () => {
      mockCircuitBreaker.isOpen.mockReturnValue(true);

      const delay = service.getBackoffDelay('stellar-rpc', 0);
      // When circuit is open, should be at least base backoff
      expect(delay).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('recordFailure()', () => {
    it('should increment consecutive failures and compute exponential backoff', () => {
      service.recordFailure('mail-provider', new Error('SMTP down'));

      const state = service.getDownstreamState('mail-provider');
      expect(state).toBeDefined();
      expect(state?.consecutiveFailures).toBe(1);
      expect(state?.currentDelayMs).toBe(5000);
      expect(state?.lastError).toBe('SMTP down');
    });

    it('should grow backoff exponentially with consecutive failures', () => {
      for (let i = 0; i < 3; i++) {
        service.recordFailure('mail-provider', new Error(`Failure ${i}`));
      }

      const state = service.getDownstreamState('mail-provider');
      expect(state?.consecutiveFailures).toBe(3);
      expect(state?.currentDelayMs).toBe(20000); // 5000 * 2^2
    });

    it('should cap backoff at max', () => {
      for (let i = 0; i < 10; i++) {
        service.recordFailure('mail-provider', new Error(`Failure ${i}`));
      }

      const state = service.getDownstreamState('mail-provider');
      expect(state?.currentDelayMs).toBe(300000); // max
    });

    it('should update circuitOpen state for stellar-rpc', () => {
      service.recordFailure('stellar-rpc', new Error('RPC timeout'));
      const state = service.getDownstreamState('stellar-rpc');
      expect(state?.circuitOpen).toBe(false); // circuit not open yet
    });
  });

  describe('recordSuccess()', () => {
    it('should reset backoff state', () => {
      service.recordFailure('mail-provider', new Error('SMTP down'));
      service.recordSuccess('mail-provider');

      const state = service.getDownstreamState('mail-provider');
      expect(state?.consecutiveFailures).toBe(0);
      expect(state?.currentDelayMs).toBe(5000);
      expect(state?.lastError).toBeNull();
    });
  });

  describe('resetDownstream()', () => {
    it('should remove downstream state', () => {
      service.recordFailure('mail-provider', new Error('SMTP down'));
      service.resetDownstream('mail-provider');

      expect(service.getDownstreamState('mail-provider')).toBeUndefined();
    });
  });

  describe('getAllDownstreamStates()', () => {
    it('should return all tracked downstreams', () => {
      service.recordFailure('mail-provider', new Error('SMTP down'));
      service.recordFailure('push-provider', new Error('FCM error'));

      const states = service.getAllDownstreamStates();
      expect(states).toHaveLength(2);
    });
  });
});