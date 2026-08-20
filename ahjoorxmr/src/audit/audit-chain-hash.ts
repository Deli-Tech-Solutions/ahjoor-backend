import { createHash } from 'crypto';

/**
 * Deterministic canonical serialisation + SHA-256 hashing for audit log
 * hash-chaining (tamper evidence).
 *
 * The same algorithm is used by:
 *   - the service at insert/append time,
 *   - the backfill migration,
 *   - the integrity verification job (which recomputes hashes and compares).
 *
 * All hashes are hex strings of 64 chars (SHA-256).
 */

export const AUDIT_CHAIN_VERSION = 1;
export const CHAIN_PARTITION_GLOBAL = 'GLOBAL';

export interface AuditChainRowInput {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  metadata: Record<string, unknown> | null;
  timestamp: string; // ISO-8601
  ipAddress: string | null;
  userAgent: string | null;
  requestPayload: Record<string, unknown> | null;
  prevHash: string;
  chainId: string;
  chainPartition: string;
  chainVersion: number;
}

/**
 * Recursively stable-stringify a value so the hash is independent of
 * JSON key insertion order (Postgres jsonb does not preserve key order).
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Build the canonical payload string that will be hashed for a single
 * audit-log row, including the previous row's hash (chain link).
 */
export function buildChainPayload(input: AuditChainRowInput): string {
  const canonical = {
    v: AUDIT_CHAIN_VERSION,
    id: input.id,
    userId: input.userId,
    action: input.action,
    resource: input.resource,
    metadata: stableStringify(input.metadata ?? {}),
    timestamp: input.timestamp,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    requestPayload: stableStringify(input.requestPayload ?? {}),
    prevHash: input.prevHash,
    chainId: input.chainId,
    chainPartition: input.chainPartition,
    chainVersion: input.chainVersion,
  };
  return JSON.stringify(canonical);
}

/**
 * Compute the SHA-256 hash for a row given the previous row's hash.
 */
export function computeRowHash(input: AuditChainRowInput): string {
  return createHash('sha256')
    .update(buildChainPayload(input))
    .digest('hex');
}