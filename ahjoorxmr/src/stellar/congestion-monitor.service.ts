import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Represents the current state of network congestion.
 * Distinguishes between true outages and degraded-but-operational states.
 */
export interface CongestionState {
  isCongestioned: boolean; // true if network is congested (slow but operational)
  isCongestionedStrict: boolean; // true if we're seeing sustained high latency percentiles
  p99LatencyMs: number; // 99th percentile latency
  p95LatencyMs: number; // 95th percentile latency
  errorRate: number; // 0-1, ratio of failures to total attempts
  successfulAttempts: number; // count of successful requests in current window
  failedAttempts: number; // count of failed requests in current window
  totalAttempts: number; // total requests in current window
  lastUpdatedAt: Date;
}

/**
 * CongestionMonitorService tracks network latency percentiles and error rates
 * to distinguish genuine network congestion from outright service failures.
 *
 * This solves the classic "circuit breaker tuning" problem: during congestion,
 * some requests succeed slowly, some fail, and some time out. This is genuinely
 * hard to distinguish from early-stage outright failure using simple thresholds.
 *
 * This service provides a congestion signal that can be shared between the
 * circuit breaker and balance monitor to avoid misclassifying slow-but-valid
 * balance reads as discrepancies.
 *
 * Strategy:
 * - Track latency for all successful requests in a sliding window
 * - Calculate p95 and p99 latencies to detect degradation
 * - Track error rate to distinguish congestion from outages
 * - Congestion = high latency percentiles + low error rate
 * - Outage = increasing error rate or all requests timing out
 */
@Injectable()
export class CongestionMonitorService {
  private readonly logger = new Logger(CongestionMonitorService.name);

  // Configuration
  private readonly windowSizeMs: number;
  private readonly p99LatencyThresholdMs: number;
  private readonly p95LatencyThresholdMs: number;
  private readonly errorRateThresholdForCongestion: number;
  private readonly minSamplesForDecision: number;

  // State
  private latencyWindow: number[] = [];
  private windowStartTime: number = Date.now();
  private successfulAttempts: number = 0;
  private failedAttempts: number = 0;

  constructor(private readonly configService: ConfigService) {
    // Sliding window for latency tracking (default: 2 minutes)
    this.windowSizeMs = this.configService.get<number>(
      'CONGESTION_WINDOW_SIZE_MS',
      120000,
    );

    // P99 latency threshold for congestion detection (default: 5000ms / 5s)
    // If 99th percentile latency exceeds this, we're likely congested
    this.p99LatencyThresholdMs = this.configService.get<number>(
      'CONGESTION_P99_THRESHOLD_MS',
      5000,
    );

    // P95 latency threshold for milder congestion (default: 2000ms / 2s)
    this.p95LatencyThresholdMs = this.configService.get<number>(
      'CONGESTION_P95_THRESHOLD_MS',
      2000,
    );

    // Error rate threshold: if error rate exceeds this while p99 is high,
    // it's probably an outage, not congestion (default: 0.25 = 25%)
    this.errorRateThresholdForCongestion = this.configService.get<number>(
      'CONGESTION_ERROR_RATE_THRESHOLD',
      0.25,
    );

    // Minimum samples required before making congestion decision (default: 10)
    this.minSamplesForDecision = this.configService.get<number>(
      'CONGESTION_MIN_SAMPLES',
      10,
    );
  }

  /**
   * Record a successful RPC request with its latency.
   * Called after every successful operation to build latency history.
   */
  recordSuccess(latencyMs: number): void {
    this.cleanOldSamples();
    this.latencyWindow.push(latencyMs);
    this.successfulAttempts++;
  }

  /**
   * Record a failed RPC request.
   * Called when an operation fails to track error rate.
   */
  recordFailure(): void {
    this.cleanOldSamples();
    this.failedAttempts++;
  }

  /**
   * Get the current congestion state.
   * Calculates latency percentiles and error rate from the sliding window.
   */
  getState(): CongestionState {
    this.cleanOldSamples();

    const totalAttempts = this.successfulAttempts + this.failedAttempts;
    const errorRate =
      totalAttempts > 0 ? this.failedAttempts / totalAttempts : 0;

    // Calculate percentiles
    const { p95, p99 } = this.calculatePercentiles();

    // Determine if we're congested:
    // - We have enough samples
    // - P99 latency is elevated
    // - Error rate is still relatively low (not an outage)
    const hasSufficientSamples = totalAttempts >= this.minSamplesForDecision;
    const isHighLatency = p99 >= this.p99LatencyThresholdMs;
    const isNotAnOutage = errorRate <= this.errorRateThresholdForCongestion;

    const isCongestioned =
      hasSufficientSamples && isHighLatency && isNotAnOutage;

    // Stricter congestion detection: both p95 and p99 elevated
    const isHighLatencyStrict =
      p95 >= this.p95LatencyThresholdMs && p99 >= this.p99LatencyThresholdMs;
    const isCongestionedStrict =
      hasSufficientSamples && isHighLatencyStrict && isNotAnOutage;

    return {
      isCongestioned,
      isCongestionedStrict,
      p99LatencyMs: Math.round(p99),
      p95LatencyMs: Math.round(p95),
      errorRate: Math.round(errorRate * 10000) / 10000, // Round to 4 decimals
      successfulAttempts: this.successfulAttempts,
      failedAttempts: this.failedAttempts,
      totalAttempts,
      lastUpdatedAt: new Date(),
    };
  }

  /**
   * Reset the monitoring window.
   * Useful for periodic resets to ensure we don't get stale data.
   */
  reset(): void {
    this.latencyWindow = [];
    this.windowStartTime = Date.now();
    this.successfulAttempts = 0;
    this.failedAttempts = 0;
    this.logger.debug('Congestion monitor window reset');
  }

  /**
   * Remove samples older than the window size.
   * Maintains a sliding window of recent latency measurements.
   */
  private cleanOldSamples(): void {
    const now = Date.now();
    const cutoffTime = now - this.windowSizeMs;

    // For latencies, we'd need timestamps, but since we're only storing values,
    // we use a simpler approach: if the window has grown too large, trim it
    // by keeping only the most recent samples.
    // In a production system, you'd store {latency, timestamp} tuples.
    if (this.latencyWindow.length > 1000) {
      // Arbitrary limit to prevent unbounded growth
      this.latencyWindow = this.latencyWindow.slice(-500);
    }

    // Reset counters periodically to ensure fresh perspective
    const windowAge = now - this.windowStartTime;
    if (windowAge > this.windowSizeMs * 2) {
      // If window is significantly older than threshold, reset to avoid stale data
      this.reset();
    }
  }

  /**
   * Calculate P95 and P99 latency percentiles from collected samples.
   */
  private calculatePercentiles(): { p95: number; p99: number } {
    if (this.latencyWindow.length === 0) {
      return { p95: 0, p99: 0 };
    }

    // Sort latencies in ascending order
    const sorted = [...this.latencyWindow].sort((a, b) => a - b);
    const len = sorted.length;

    // P95: 95th percentile
    const p95Index = Math.ceil((95 / 100) * len) - 1;
    const p95 = sorted[Math.max(0, p95Index)];

    // P99: 99th percentile
    const p99Index = Math.ceil((99 / 100) * len) - 1;
    const p99 = sorted[Math.max(0, p99Index)];

    return { p95, p99 };
  }

  /**
   * Get debug information about the current monitoring state.
   * Useful for logging and debugging congestion scenarios.
   */
  getDebugInfo(): {
    windowSizeMs: number;
    samplesCollected: number;
    windowAgeMs: number;
    medianLatencyMs: number;
  } {
    if (this.latencyWindow.length === 0) {
      return {
        windowSizeMs: this.windowSizeMs,
        samplesCollected: 0,
        windowAgeMs: Date.now() - this.windowStartTime,
        medianLatencyMs: 0,
      };
    }

    const sorted = [...this.latencyWindow].sort((a, b) => a - b);
    const medianIndex = Math.floor(sorted.length / 2);
    const medianLatencyMs = sorted[medianIndex];

    return {
      windowSizeMs: this.windowSizeMs,
      samplesCollected: this.latencyWindow.length,
      windowAgeMs: Date.now() - this.windowStartTime,
      medianLatencyMs,
    };
  }
}
