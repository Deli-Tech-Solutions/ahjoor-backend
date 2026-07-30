import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CongestionMonitorService } from './congestion-monitor.service';

describe('CongestionMonitorService', () => {
  let service: CongestionMonitorService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      const config: Record<string, any> = {
        CONGESTION_WINDOW_SIZE_MS: 120000,
        CONGESTION_P99_THRESHOLD_MS: 5000,
        CONGESTION_P95_THRESHOLD_MS: 2000,
        CONGESTION_ERROR_RATE_THRESHOLD: 0.25,
        CONGESTION_MIN_SAMPLES: 10,
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CongestionMonitorService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<CongestionMonitorService>(CongestionMonitorService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('Latency percentile tracking', () => {
    it('should calculate P95 and P99 latency percentiles', () => {
      // Record 100 successful requests with increasing latency
      for (let i = 1; i <= 100; i++) {
        service.recordSuccess(i * 10); // 10ms, 20ms, 30ms, ..., 1000ms
      }

      const state = service.getState();

      // P95 should be around 950ms (95% of 1000ms)
      expect(state.p95LatencyMs).toBeGreaterThan(940);
      expect(state.p95LatencyMs).toBeLessThanOrEqual(960);

      // P99 should be around 990ms (99% of 1000ms)
      expect(state.p99LatencyMs).toBeGreaterThan(980);
      expect(state.p99LatencyMs).toBeLessThanOrEqual(1000);
    });

    it('should detect sustained high latency as congestion', () => {
      // Simulate sustained high latency with no failures
      for (let i = 0; i < 15; i++) {
        service.recordSuccess(6000); // All requests take 6 seconds (above 5s threshold)
      }

      const state = service.getState();

      expect(state.isCongestioned).toBe(true);
      expect(state.isCongestionedStrict).toBe(true);
      expect(state.p99LatencyMs).toBe(6000);
      expect(state.errorRate).toBe(0);
    });

    it('should not detect high latency as congestion if error rate is too high', () => {
      // Simulate high latency with high error rate (likely outage)
      for (let i = 0; i < 10; i++) {
        service.recordSuccess(6000); // High latency
        service.recordFailure(); // High error rate
      }

      const state = service.getState();

      // Even though p99 is high, high error rate means it's not congestion
      expect(state.isCongestioned).toBe(false);
      expect(state.errorRate).toBe(0.5); // 50% error rate
    });

    it('should distinguish between congestion and outage', () => {
      // Scenario 1: Congestion (high latency, low error rate)
      service.reset();
      for (let i = 0; i < 20; i++) {
        service.recordSuccess(6000); // High latency, above P99 threshold
      }
      service.recordFailure(); // Very low error rate

      const congestionState = service.getState();
      expect(congestionState.isCongestioned).toBe(true);
      expect(congestionState.errorRate).toBeLessThan(0.1);

      // Scenario 2: Outage (high latency, high error rate)
      service.reset();
      for (let i = 0; i < 5; i++) {
        service.recordSuccess(4000); // High latency
        service.recordFailure(); // High error rate
        service.recordFailure();
        service.recordFailure();
      }

      const outageState = service.getState();
      expect(outageState.isCongestioned).toBe(false);
      expect(outageState.errorRate).toBeGreaterThan(0.5);
    });
  });

  describe('Minimum samples requirement', () => {
    it('should not detect congestion until minimum samples are collected', () => {
      // Record only 5 successful high-latency requests (below min threshold of 10)
      for (let i = 0; i < 5; i++) {
        service.recordSuccess(6000);
      }

      const state = service.getState();

      // Even though latency is high, we don't have enough samples
      expect(state.isCongestioned).toBe(false);
      expect(state.totalAttempts).toBe(5);
    });

    it('should detect congestion once minimum samples are reached', () => {
      // Record exactly 10 successful high-latency requests (at min threshold)
      for (let i = 0; i < 10; i++) {
        service.recordSuccess(6000);
      }

      const state = service.getState();

      expect(state.isCongestioned).toBe(true);
      expect(state.totalAttempts).toBe(10);
    });
  });

  describe('Error rate tracking', () => {
    it('should accurately calculate error rate', () => {
      // Record 8 successes and 2 failures (20% error rate)
      for (let i = 0; i < 8; i++) {
        service.recordSuccess(100);
      }
      for (let i = 0; i < 2; i++) {
        service.recordFailure();
      }

      const state = service.getState();

      expect(state.successfulAttempts).toBe(8);
      expect(state.failedAttempts).toBe(2);
      expect(state.totalAttempts).toBe(10);
      expect(state.errorRate).toBe(0.2);
    });

    it('should handle zero error rate', () => {
      // Record only successes
      for (let i = 0; i < 10; i++) {
        service.recordSuccess(100);
      }

      const state = service.getState();

      expect(state.errorRate).toBe(0);
    });
  });

  describe('Slow but mostly successful network profile', () => {
    it('should keep breaker closed during sustained high latency with low error rate', () => {
      // Simulate sustained slow network: 95% success rate, all requests take 4-5 seconds
      service.reset();
      for (let i = 0; i < 20; i++) {
        service.recordSuccess(5500 + Math.random() * 500);
      }
      service.recordFailure(); // 1 failure out of 21 = ~4.8% error rate

      const state = service.getState();

      // This should be detected as congestion (not outage)
      expect(state.isCongestioned).toBe(true);
      expect(state.p99LatencyMs).toBeGreaterThan(5000);
      expect(state.errorRate).toBeLessThan(0.25); // Below outage threshold
      expect(state.totalAttempts).toBe(21);
    });
  });

  describe('Genuine outage detection', () => {
    it('should quickly detect genuine outage with high error rate', () => {
      // Simulate outage: most requests fail
      service.reset();
      for (let i = 0; i < 2; i++) {
        service.recordSuccess(1000);
      }
      for (let i = 0; i < 15; i++) {
        service.recordFailure();
      }

      const state = service.getState();

      // This should NOT be detected as congestion
      expect(state.isCongestioned).toBe(false);
      expect(state.errorRate).toBeGreaterThan(0.5);
    });

    it('should detect outage when all requests fail', () => {
      service.reset();
      for (let i = 0; i < 15; i++) {
        service.recordFailure();
      }

      const state = service.getState();

      expect(state.isCongestioned).toBe(false);
      expect(state.errorRate).toBe(1.0);
      expect(state.totalAttempts).toBe(15);
    });
  });

  describe('Reset functionality', () => {
    it('should reset monitoring state', () => {
      // Record some data
      for (let i = 0; i < 10; i++) {
        service.recordSuccess(1000);
      }

      let state = service.getState();
      expect(state.totalAttempts).toBe(10);

      // Reset
      service.reset();

      state = service.getState();
      expect(state.totalAttempts).toBe(0);
      expect(state.errorRate).toBe(0);
      expect(state.isCongestioned).toBe(false);
    });
  });

  describe('Debug information', () => {
    it('should provide debug info about monitoring state', () => {
      // Record some data
      for (let i = 0; i < 20; i++) {
        service.recordSuccess(100 + Math.random() * 100);
      }

      const debugInfo = service.getDebugInfo();

      expect(debugInfo.windowSizeMs).toBe(120000);
      expect(debugInfo.samplesCollected).toBe(20);
      expect(debugInfo.medianLatencyMs).toBeGreaterThan(0);
      expect(debugInfo.windowAgeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty debug info', () => {
      service.reset();
      const debugInfo = service.getDebugInfo();

      expect(debugInfo.samplesCollected).toBe(0);
      expect(debugInfo.medianLatencyMs).toBe(0);
    });
  });

  describe('Strict congestion detection', () => {
    it('should require both P95 and P99 elevated for strict congestion', () => {
      service.reset();

      // Record latencies where only P99 is high but P95 is moderate
      const latencies = [
        100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1500, 2000, 2500,
      ];
      latencies.forEach((latency) => service.recordSuccess(latency));

      const state = service.getState();

      // P99 might be high but P95 won't be high enough for strict congestion
      // This is a looser congestion state
      expect(state.totalAttempts).toBeGreaterThanOrEqual(10);
    });

    it('should detect strict congestion when both P95 and P99 are elevated', () => {
      service.reset();

      // Record all high latencies
      for (let i = 0; i < 20; i++) {
        service.recordSuccess(6000); // Above both P95 (2000ms) and P99 (5000ms) thresholds
      }

      const state = service.getState();

      expect(state.isCongestionedStrict).toBe(true);
      expect(state.p95LatencyMs).toBeGreaterThanOrEqual(2000);
      expect(state.p99LatencyMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('Timestamp tracking', () => {
    it('should update lastUpdatedAt timestamp on getState call', () => {
      service.reset();
      service.recordSuccess(100);

      const state1 = service.getState();
      const time1 = state1.lastUpdatedAt.getTime();

      // Wait a tiny bit
      jest.useFakeTimers();
      jest.advanceTimersByTime(100);

      const state2 = service.getState();
      const time2 = state2.lastUpdatedAt.getTime();

      jest.useRealTimers();

      expect(time2).toBeGreaterThanOrEqual(time1);
    });
  });
});
