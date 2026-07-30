import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CongestionMonitorService,
  CongestionState,
} from './congestion-monitor.service';

interface CircuitState {
  failures: number;
  lastFailureAt: number | null;
  isOpen: boolean;
  lastHalfOpenProbeAt: number | null; // Track when we last tried to recover
}

/**
 * StellarCircuitBreakerService implements a circuit breaker pattern with:
 * - Adaptive latency-percentile-aware thresholds (via CongestionMonitorService)
 * - Rate-limited half-open probes to avoid self-inflicted re-tripping
 * - Shared congestion signals to distinguish network degradation from outages
 */
@Injectable()
export class StellarCircuitBreakerService {
  private readonly logger = new Logger(StellarCircuitBreakerService.name);
  private readonly threshold: number;
  private readonly baseTimeoutMs: number;
  private readonly networkName: string;
  private readonly webhookUrl: string | undefined;
  private readonly minHalfOpenProbeIntervalMs: number; // Rate-limit half-open probes
  private readonly maxHalfOpenProbeIntervalMs: number;
  private state: CircuitState = {
    failures: 0,
    lastFailureAt: null,
    isOpen: false,
    lastHalfOpenProbeAt: null,
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly congestionMonitor: CongestionMonitorService,
  ) {
    this.threshold = this.configService.get<number>(
      'STELLAR_CIRCUIT_BREAKER_THRESHOLD',
      5,
    );
    this.baseTimeoutMs =
      this.configService.get<number>('STELLAR_CIRCUIT_BREAKER_TIMEOUT', 60) *
      1000;
    this.networkName = this.configService.get<string>(
      'STELLAR_NETWORK',
      'testnet',
    );
    this.webhookUrl = this.configService.get<string>(
      'STELLAR_ALERT_WEBHOOK_URL',
    );

    // Rate-limit half-open probe attempts to avoid self-inflicted re-tripping
    // Min: 5 seconds between probes (default)
    this.minHalfOpenProbeIntervalMs = this.configService.get<number>(
      'STELLAR_CIRCUIT_BREAKER_MIN_PROBE_INTERVAL_MS',
      5000,
    );
    // Max: 30 seconds between probes during sustained congestion
    this.maxHalfOpenProbeIntervalMs = this.configService.get<number>(
      'STELLAR_CIRCUIT_BREAKER_MAX_PROBE_INTERVAL_MS',
      30000,
    );
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();

    if (this.state.isOpen) {
      const elapsed = Date.now() - (this.state.lastFailureAt ?? 0);
      const timeoutMs = this.getAdaptiveTimeout();

      if (elapsed < timeoutMs) {
        throw new ServiceUnavailableException({
          error: 'Stellar network unavailable',
          retryAfter: Math.ceil((timeoutMs - elapsed) / 1000),
        });
      }

      // Half-open: check if we should attempt recovery
      if (!this.shouldAttemptRecoveryProbe()) {
        throw new ServiceUnavailableException({
          error: 'Stellar network unavailable (probe rate-limited)',
          retryAfter: Math.ceil(this.getNextProbeDelayMs() / 1000),
        });
      }

      // Mark probe start immediately so concurrent/rapid calls are rate-limited
      // even while this probe is still in flight.
      this.state.lastHalfOpenProbeAt = Date.now();
      this.logger.log('Circuit half-open, attempting recovery probe');
    }

    try {
      const result = await fn();
      const latencyMs = Date.now() - startTime;

      this.onSuccess(latencyMs);
      return result;
    } catch (err) {
      this.onFailure(err as Error);
      throw err;
    }
  }

  /**
   * Determine if we should attempt a recovery probe.
   * Uses rate-limiting to avoid immediate re-tripping on residual slowness.
   */
  private shouldAttemptRecoveryProbe(): boolean {
    const now = Date.now();
    const lastProbe = this.state.lastHalfOpenProbeAt ?? 0;
    const timeSinceLastProbe = now - lastProbe;

    // Only allow probe if minimum interval has passed
    const canProbe = timeSinceLastProbe >= this.minHalfOpenProbeIntervalMs;

    if (!canProbe) {
      this.logger.debug(
        `Probe rate-limited: last probe ${timeSinceLastProbe}ms ago, min interval: ${this.minHalfOpenProbeIntervalMs}ms`,
      );
    }

    return canProbe;
  }

  /**
   * Calculate delay until next probe is allowed.
   * Useful for communicating back-off to callers.
   */
  private getNextProbeDelayMs(): number {
    const now = Date.now();
    const lastProbe = this.state.lastHalfOpenProbeAt ?? 0;
    const timeSinceLastProbe = now - lastProbe;

    const delayMs = Math.max(
      0,
      this.minHalfOpenProbeIntervalMs - timeSinceLastProbe,
    );

    return delayMs;
  }

  /**
   * Determine adaptive timeout based on congestion state.
   * If network is congested but operational, use shorter timeout.
   * If network appears down, use longer timeout.
   */
  private getAdaptiveTimeout(): number {
    const congestionState = this.congestionMonitor.getState();

    // If we're just congested (not in outage), recover faster
    // Congestion should resolve within the base timeout / 2
    if (congestionState.isCongestioned && !this.isLikelyOutage()) {
      this.logger.debug(
        `Adaptive timeout: congestion detected, using reduced timeout of ${Math.floor(this.baseTimeoutMs / 2)}ms`,
      );
      return Math.floor(this.baseTimeoutMs / 2);
    }

    // Otherwise, use base timeout
    return this.baseTimeoutMs;
  }

  /**
   * Heuristic to detect likely outage vs congestion.
   * High error rate + high latency = likely outage
   * High latency + low error rate = likely congestion
   */
  private isLikelyOutage(): boolean {
    const congestionState = this.congestionMonitor.getState();

    // If error rate is very high (>50%), it's probably an outage
    return congestionState.errorRate > 0.5;
  }

  private onSuccess(latencyMs: number): void {
    // Record success in congestion monitor
    this.congestionMonitor.recordSuccess(latencyMs);

    if (this.state.isOpen) {
      this.logger.log(
        `Circuit closed after successful recovery (latency: ${latencyMs}ms)`,
      );
    }

    this.state = {
      failures: 0,
      lastFailureAt: null,
      isOpen: false,
      lastHalfOpenProbeAt: null,
    };
  }

  private onFailure(err: Error): void {
    // Record failure in congestion monitor
    this.congestionMonitor.recordFailure();

    this.state.failures += 1;
    this.state.lastFailureAt = Date.now();

    // Update last probe time if circuit is in half-open state
    if (this.state.isOpen) {
      this.state.lastHalfOpenProbeAt = Date.now();
    }

    if (this.state.failures >= this.threshold) {
      const wasOpen = this.state.isOpen;
      this.state.isOpen = true;

      if (!wasOpen) {
        const congestionState = this.congestionMonitor.getState();
        this.logger.error(
          JSON.stringify({
            event: 'stellar_circuit_opened',
            network: this.networkName,
            failures: this.state.failures,
            lastError: err.message,
            congestionState: {
              isCongestioned: congestionState.isCongestioned,
              p99LatencyMs: congestionState.p99LatencyMs,
              errorRate: congestionState.errorRate,
            },
          }),
        );
        this.sendWebhookAlert(err.message, congestionState).catch(() => {});
      }
    }
  }

  /**
   * Check if circuit is currently open.
   */
  isOpen(): boolean {
    return this.state.isOpen;
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return { ...this.state };
  }

  /**
   * Get current congestion state from monitor.
   */
  getCongestionState(): CongestionState {
    return this.congestionMonitor.getState();
  }

  /**
   * Reset the circuit and congestion monitor.
   * Useful for testing and manual recovery.
   */
  reset(): void {
    this.state = {
      failures: 0,
      lastFailureAt: null,
      isOpen: false,
      lastHalfOpenProbeAt: null,
    };
    this.congestionMonitor.reset();
    this.logger.log('Circuit breaker and congestion monitor reset');
  }

  private async sendWebhookAlert(
    lastError: string,
    congestionState: CongestionState,
  ): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({
        default: null as any,
      }));
      if (!fetch) return;
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'stellar_circuit_opened',
          network: this.networkName,
          lastError,
          timestamp: new Date().toISOString(),
          congestionState: {
            isCongestioned: congestionState.isCongestioned,
            p99LatencyMs: congestionState.p99LatencyMs,
            p95LatencyMs: congestionState.p95LatencyMs,
            errorRate: congestionState.errorRate,
            totalAttempts: congestionState.totalAttempts,
          },
        }),
      });
    } catch {
      // Webhook failure is non-critical
    }
  }
}
