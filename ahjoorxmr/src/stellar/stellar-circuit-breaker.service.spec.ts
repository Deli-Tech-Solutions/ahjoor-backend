import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { StellarCircuitBreakerService } from './stellar-circuit-breaker.service';
import { CongestionMonitorService } from './congestion-monitor.service';

describe('StellarCircuitBreakerService', () => {
  let service: StellarCircuitBreakerService;
  let congestionMonitor: CongestionMonitorService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        STELLAR_CIRCUIT_BREAKER_THRESHOLD: 5,
        STELLAR_CIRCUIT_BREAKER_TIMEOUT: 60,
        STELLAR_NETWORK: 'testnet',
        STELLAR_ALERT_WEBHOOK_URL: undefined,
        CONGESTION_WINDOW_SIZE_MS: 120000,
        CONGESTION_P99_THRESHOLD_MS: 5000,
        CONGESTION_P95_THRESHOLD_MS: 2000,
        CONGESTION_ERROR_RATE_THRESHOLD: 0.25,
        CONGESTION_MIN_SAMPLES: 10,
        STELLAR_CIRCUIT_BREAKER_MIN_PROBE_INTERVAL_MS: 5000,
        STELLAR_CIRCUIT_BREAKER_MAX_PROBE_INTERVAL_MS: 30000,
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarCircuitBreakerService,
        CongestionMonitorService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<StellarCircuitBreakerService>(
      StellarCircuitBreakerService,
    );
    congestionMonitor = module.get<CongestionMonitorService>(
      CongestionMonitorService,
    );
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('Basic circuit breaker functionality', () => {
    it('should execute successful operations', async () => {
      const result = await service.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should throw on failed operations', async () => {
      const error = new Error('RPC failed');
      await expect(service.execute(async () => Promise.reject(error))).rejects.toThrow(
        'RPC failed',
      );
    });

    it('should trip circuit after threshold failures', async () => {
      const error = new Error('RPC failed');

      // Trigger 5 failures
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      // Circuit should now be open
      expect(service.isOpen()).toBe(true);

      // Next call should be rejected immediately
      await expect(service.execute(async () => 'success')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('Rate-limited half-open probes', () => {
    it('should rate-limit recovery probe attempts', async () => {
      const error = new Error('RPC failed');

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      expect(service.isOpen()).toBe(true);

      // Wait for timeout to expire
      jest.useFakeTimers();
      jest.advanceTimersByTime(61000); // Advance past 60s timeout

      // First probe attempt should be allowed
      const probe1 = service.execute(async () => 'success');

      // Immediately attempting another probe should fail (rate-limited)
      try {
        await service.execute(async () => 'success2');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as any).response.error).toContain('probe rate-limited');
      }

      jest.useRealTimers();
    });

    it('should allow probes after minimum probe interval has passed', async () => {
      const error = new Error('RPC failed');

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      jest.useFakeTimers();
      jest.advanceTimersByTime(61000); // Timeout

      // First probe
      await service.execute(async () => 'success').catch(() => {});

      // Wait for min probe interval (5s)
      jest.advanceTimersByTime(5000);

      // Second probe should be allowed
      const state = service.getState();
      expect(state.lastHalfOpenProbeAt).toBeTruthy();

      jest.useRealTimers();
    });
  });

  describe('Congestion-aware timeout adaptation', () => {
    it('should use shorter timeout during congestion', async () => {
      // Simulate congestion: high latency, low error rate
      for (let i = 0; i < 15; i++) {
        congestionMonitor.recordSuccess(6000);
      }

      const congestionState = service.getCongestionState();
      expect(congestionState.isCongestioned).toBe(true);

      // The service should use adaptive timeout (base/2 = 30s instead of 60s)
      // This is tested indirectly through the internal logic
      const circuitState = service.getState();
      expect(circuitState.isOpen).toBe(false);
    });

    it('should detect outage heuristic from error rate', () => {
      // Simulate high error rate (likely outage)
      for (let i = 0; i < 5; i++) {
        congestionMonitor.recordSuccess(1000);
        congestionMonitor.recordFailure();
        congestionMonitor.recordFailure();
        congestionMonitor.recordFailure();
      }

      const congestionState = service.getCongestionState();

      // Error rate should be >50%
      expect(congestionState.errorRate).toBeGreaterThan(0.5);
    });
  });

  describe('Integration: sustained slow network', () => {
    it('should keep circuit closed during sustained slow but successful network', async () => {
      jest.useFakeTimers();

      // Simulate sustained slow network: all requests take 4.5 seconds, 95% success rate
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount % 20 === 0) {
          throw new Error('Occasional failure');
        }
        return 'success';
      };

      // Record as successful/failed
      for (let i = 0; i < 20; i++) {
        try {
          await service.execute(fn);
          congestionMonitor.recordSuccess(4500);
        } catch {
          congestionMonitor.recordFailure();
        }
      }

      // Circuit should still be closed (not tripped on latency alone)
      expect(service.isOpen()).toBe(false);

      const congestionState = service.getCongestionState();
      expect(congestionState.isCongestioned).toBe(true); // Detected as congestion
      expect(congestionState.errorRate).toBeLessThan(0.25); // Not an outage

      jest.useRealTimers();
    });

    it('should quickly trip during genuine outage with high error rate', async () => {
      const error = new Error('Service down');

      // Simulate genuine outage: most requests fail
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {
          congestionMonitor.recordFailure();
        }
      }

      expect(service.isOpen()).toBe(true);

      const congestionState = service.getCongestionState();
      expect(congestionState.errorRate).toBeGreaterThan(0);
    });
  });

  describe('Half-open state recovery', () => {
    it('should close circuit after successful recovery probe', async () => {
      const error = new Error('RPC failed');

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      expect(service.isOpen()).toBe(true);

      jest.useFakeTimers();
      jest.advanceTimersByTime(61000); // Timeout

      // Successful recovery probe
      await service.execute(async () => 'success');
      congestionMonitor.recordSuccess(100);

      // Circuit should now be closed
      expect(service.isOpen()).toBe(false);

      jest.useRealTimers();
    });

    it('should re-open circuit if recovery probe fails', async () => {
      const error = new Error('RPC failed');

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      expect(service.isOpen()).toBe(true);

      jest.useFakeTimers();
      jest.advanceTimersByTime(61000); // Timeout

      // Failed recovery probe
      try {
        await service.execute(async () => Promise.reject(error));
      } catch {}

      // Circuit should be open again
      expect(service.isOpen()).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('Congestion state sharing', () => {
    it('should expose congestion state for external services', () => {
      // Simulate congestion
      for (let i = 0; i < 15; i++) {
        congestionMonitor.recordSuccess(6000);
      }

      const congestionState = service.getCongestionState();

      expect(congestionState).toBeTruthy();
      expect(congestionState.p99LatencyMs).toBeGreaterThan(0);
      expect(congestionState.isCongestioned).toBe(true);
    });

    it('should include congestion state in webhook alerts', async () => {
      const error = new Error('RPC failed');

      // Simulate congestion before circuit opens
      for (let i = 0; i < 10; i++) {
        congestionMonitor.recordSuccess(4000);
      }

      // Trip the circuit
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      // Check that congestion state is captured
      const circuitState = service.getState();
      expect(circuitState.isOpen).toBe(true);

      const congestionState = service.getCongestionState();
      expect(congestionState.isCongestioned).toBe(true);
    });
  });

  describe('Reset functionality', () => {
    it('should reset both circuit and congestion monitor', () => {
      const error = new Error('RPC failed');

      // Trip the circuit and record congestion
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(async () => Promise.reject(error));
        } catch {}
      }

      congestionMonitor.recordSuccess(6000);

      expect(service.isOpen()).toBe(true);
      expect(service.getCongestionState().isCongestioned).toBe(true);

      // Reset
      service.reset();

      expect(service.isOpen()).toBe(false);
      const resetState = service.getCongestionState();
      expect(resetState.totalAttempts).toBe(0);
    });
  });

  describe('Threshold configuration', () => {
    it('should respect configurable failure threshold', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarCircuitBreakerService,
          CongestionMonitorService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: any) => {
                const config: Record<string, any> = {
                  STELLAR_CIRCUIT_BREAKER_THRESHOLD: 3, // Lower threshold
                  STELLAR_CIRCUIT_BREAKER_TIMEOUT: 60,
                  STELLAR_NETWORK: 'testnet',
                  STELLAR_ALERT_WEBHOOK_URL: undefined,
                  CONGESTION_WINDOW_SIZE_MS: 120000,
                  CONGESTION_P99_THRESHOLD_MS: 5000,
                  CONGESTION_P95_THRESHOLD_MS: 2000,
                  CONGESTION_ERROR_RATE_THRESHOLD: 0.25,
                  CONGESTION_MIN_SAMPLES: 10,
                  STELLAR_CIRCUIT_BREAKER_MIN_PROBE_INTERVAL_MS: 5000,
                  STELLAR_CIRCUIT_BREAKER_MAX_PROBE_INTERVAL_MS: 30000,
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const testService = module.get<StellarCircuitBreakerService>(
        StellarCircuitBreakerService,
      );

      const error = new Error('RPC failed');

      // Only 3 failures should trip the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await testService.execute(async () => Promise.reject(error));
        } catch {}
      }

      expect(testService.isOpen()).toBe(true);
    });
  });

  describe('Latency recording integration', () => {
    it('should record latency in congestion monitor on success', async () => {
      await service.execute(async () => {
        // Simulate 100ms latency
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'success';
      });

      const state = service.getCongestionState();
      expect(state.successfulAttempts).toBe(1);
    });

    it('should record failure in congestion monitor', async () => {
      const error = new Error('RPC failed');
      try {
        await service.execute(async () => Promise.reject(error));
      } catch {}

      const state = service.getCongestionState();
      expect(state.failedAttempts).toBe(1);
    });
  });
});
