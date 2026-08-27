import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { createHash } from 'crypto';

/**
 * Represents a failure signature used to detect poison messages.
 * A poison message is a job that deterministically fails every attempt
 * with the same payload and error class.
 */
export interface FailureSignature {
  /** Hash of the error class + payload to detect identical failures */
  signature: string;
  /** Error class name (e.g. 'Error', 'ServiceUnavailableException') */
  errorClass: string;
  /** First time this signature was observed */
  firstSeenAt: number;
  /** Last time this signature was observed */
  lastSeenAt: number;
  /** Consecutive failures with this exact signature */
  consecutiveFailures: number;
}

export interface PoisonMessageDetectionResult {
  isPoison: boolean;
  consecutiveFailures: number;
  threshold: number;
  signature: string;
  errorClass: string;
}

/**
 * PoisonMessageDetectorService detects "poison messages" — jobs that
 * deterministically fail every attempt with an unchanged payload and
 * error class. Such jobs should be routed to the dead-letter queue
 * immediately rather than consuming retry slots and starving healthy jobs.
 *
 * Detection strategy:
 * - Compute a failure signature = SHA-256(errorClass + canonical payload)
 * - Track consecutive failures with the same signature per job
 * - When consecutive failures reach the configured threshold, flag as poison
 */
@Injectable()
export class PoisonMessageDetectorService {
  private readonly logger = new Logger(PoisonMessageDetectorService.name);

  /** Map of jobId -> failure signature tracking */
  private readonly failureTracker = new Map<string, FailureSignature>();

  /** Consecutive failures required to classify a job as poison */
  private readonly poisonThreshold: number;

  /** Time window (ms) after which a failure signature is considered stale */
  private readonly signatureTtlMs: number;

  /** Max entries to keep in the in-memory tracker to prevent unbounded growth */
  private readonly maxTrackerEntries: number;

  constructor(private readonly configService: ConfigService) {
    this.poisonThreshold = this.configService.get<number>(
      'POISON_MESSAGE_THRESHOLD',
      3,
    );
    this.signatureTtlMs = this.configService.get<number>(
      'POISON_MESSAGE_SIGNATURE_TTL_MS',
      30 * 60 * 1000, // 30 minutes
    );
    this.maxTrackerEntries = this.configService.get<number>(
      'POISON_MESSAGE_MAX_TRACKER_ENTRIES',
      10_000,
    );
  }

  /**
   * Record a job failure and determine if it's a poison message.
   * Called from the global BullMQ 'failed' event handler.
   *
   * @param job The failed BullMQ job
   * @param error The error that caused the failure
   * @returns Detection result indicating whether this is a poison message
   */
  recordFailure(job: Job, error: Error): PoisonMessageDetectionResult {
    const jobId = String(job.id ?? 'unknown');
    const errorClass = error.constructor?.name ?? 'Error';
    const signature = this.computeSignature(errorClass, job.data);

    const now = Date.now();
    const existing = this.failureTracker.get(jobId);

    // If we have a previous failure for this job, check if the signature matches
    if (existing) {
      // If the signature changed, reset the consecutive counter
      if (existing.signature !== signature) {
        this.failureTracker.set(jobId, {
          signature,
          errorClass,
          firstSeenAt: now,
          lastSeenAt: now,
          consecutiveFailures: 1,
        });
        return {
          isPoison: false,
          consecutiveFailures: 1,
          threshold: this.poisonThreshold,
          signature,
          errorClass,
        };
      }

      // Same signature — increment consecutive failures
      const updated: FailureSignature = {
        ...existing,
        lastSeenAt: now,
        consecutiveFailures: existing.consecutiveFailures + 1,
      };
      this.failureTracker.set(jobId, updated);

      const isPoison = updated.consecutiveFailures >= this.poisonThreshold;
      if (isPoison) {
        this.logger.warn(
          `Poison message detected: jobId=${jobId} jobName=${job.name} ` +
            `consecutiveFailures=${updated.consecutiveFailures}/${this.poisonThreshold} ` +
            `errorClass=${errorClass} signature=${signature.slice(0, 12)}...`,
        );
      }

      return {
        isPoison,
        consecutiveFailures: updated.consecutiveFailures,
        threshold: this.poisonThreshold,
        signature,
        errorClass,
      };
    }

    // First failure for this job
    this.failureTracker.set(jobId, {
      signature,
      errorClass,
      firstSeenAt: now,
      lastSeenAt: now,
      consecutiveFailures: 1,
    });

    this.enforceTrackerLimit();

    return {
      isPoison: false,
      consecutiveFailures: 1,
      threshold: this.poisonThreshold,
      signature,
      errorClass,
    };
  }

  /**
   * Check if a job is currently flagged as a poison message.
   * Useful for admin endpoints to inspect poison-message status.
   */
  getPoisonStatus(jobId: string): FailureSignature | undefined {
    const entry = this.failureTracker.get(jobId);
    if (!entry) return undefined;

    // Check if the signature has gone stale
    if (Date.now() - entry.lastSeenAt > this.signatureTtlMs) {
      this.failureTracker.delete(jobId);
      return undefined;
    }

    return { ...entry };
  }

  /**
   * Get all currently tracked poison-message candidates.
   * Used by admin endpoints for visibility.
   */
  getAllPoisonCandidates(): Array<{
    jobId: string;
    signature: FailureSignature;
  }> {
    this.cleanupStaleEntries();
    const result: Array<{ jobId: string; signature: FailureSignature }> = [];
    for (const [jobId, signature] of this.failureTracker.entries()) {
      if (signature.consecutiveFailures >= this.poisonThreshold) {
        result.push({ jobId, signature: { ...signature } });
      }
    }
    return result;
  }

  /**
   * Clear the failure tracker for a specific job.
   * Called when a job succeeds or is manually retried.
   */
  clearJob(jobId: string): void {
    this.failureTracker.delete(jobId);
  }

  /**
   * Reset the entire tracker.
   * Useful for testing and manual recovery.
   */
  reset(): void {
    this.failureTracker.clear();
    this.logger.log('Poison message detector tracker reset');
  }

  /**
   * Compute a deterministic signature from error class + payload.
   * Uses SHA-256 to create a compact, comparable hash.
   */
  private computeSignature(errorClass: string, data: unknown): string {
    const canonicalPayload = this.canonicalize(data);
    return createHash('sha256')
      .update(`${errorClass}:${canonicalPayload}`)
      .digest('hex');
  }

  /**
   * Canonicalize a payload to a stable string representation.
   * Sorts object keys recursively to ensure identical payloads
   * produce identical signatures regardless of key order.
   */
  private canonicalize(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.canonicalize(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${k}:${this.canonicalize(obj[k])}`)
      .join(',')}}`;
  }

  /**
   * Remove stale entries and enforce the max tracker size.
   */
  private cleanupStaleEntries(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.failureTracker.entries()) {
      if (now - entry.lastSeenAt > this.signatureTtlMs) {
        this.failureTracker.delete(jobId);
      }
    }
  }

  /**
   * If the tracker exceeds the max size, evict the oldest entries.
   */
  private enforceTrackerLimit(): void {
    if (this.failureTracker.size <= this.maxTrackerEntries) return;

    // Evict oldest entries by firstSeenAt
    const entries = [...this.failureTracker.entries()].sort(
      (a, b) => a[1].firstSeenAt - b[1].firstSeenAt,
    );
    const toEvict = entries.slice(
      0,
      this.failureTracker.size - this.maxTrackerEntries,
    );
    for (const [jobId] of toEvict) {
      this.failureTracker.delete(jobId);
    }
    this.logger.warn(
      `Poison message tracker exceeded max size (${this.maxTrackerEntries}); evicted ${toEvict.length} entries`,
    );
  }
}