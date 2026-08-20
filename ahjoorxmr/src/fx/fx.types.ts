/**
 * FX / multi-asset types for Ahjoor.
 *
 * A group is denominated in a single **unit-of-account asset** (e.g. USDC).
 * Members may contribute in that asset OR in another supported asset (e.g. XLM).
 * When a contribution is made in a non-unit asset, an FX rate is captured at
 * submission time and locked for the duration of the contribution lifecycle.
 */

/** Stellar asset identifier (code + optional issuer). */
export interface AssetRef {
  /** Stellar asset code, e.g. 'XLM', 'USDC'. Max 12 chars. */
  code: string;
  /** Stellar issuer G-address. Null for native XLM. */
  issuer: string | null;
}

/** Outcome of a path-payment submission. */
export enum PathPaymentOutcome {
  /** The full destination amount was delivered. */
  FULL_FILL = 'FULL_FILL',
  /** The destination received less than requested but within the tolerance band. */
  PARTIAL_FILL = 'PARTIAL_FILL',
  /** The conversion rate moved beyond the tolerance band; no fill was accepted. */
  SLIPPAGE_EXCEEDED = 'SLIPPAGE_EXCEEDED',
  /** The transaction failed for a non-slippage reason (e.g. insufficient balance, bad trustline). */
  FAILED = 'FAILED',
}

/** Result of a path-payment submission. */
export interface PathPaymentResult {
  outcome: PathPaymentOutcome;
  /** Amount actually delivered to the destination (in destination asset). */
  deliveredAmount: string;
  /** Amount requested at the destination (in destination asset). */
  requestedAmount: string;
  /** Effective rate delivered (destination per source). */
  effectiveRate: string;
  /** Locked rate at submission (destination per source). */
  lockedRate: string;
  /** Transaction hash if the payment was submitted. */
  txHash?: string;
  /** Human-readable reason for non-full-fill outcomes. */
  reason?: string;
}

/** A locked FX rate captured at contribution submission time. */
export interface LockedFxRate {
  /** Source asset (what the contributor paid in). */
  source: AssetRef;
  /** Destination asset (the group's unit of account). */
  destination: AssetRef;
  /** Rate: 1 unit of source = `rate` units of destination. */
  rate: string;
  /** ISO timestamp when the rate was captured. */
  capturedAt: string;
  /** ISO timestamp after which the rate is no longer honored. */
  expiresAt: string;
  /** Tolerance band in basis points (1 bp = 0.01%). e.g. 200 = ±2%. */
  toleranceBps: number;
}

/** FX policy configured on a group. */
export interface FxPolicy {
  /** How long a captured rate remains valid, in seconds. Default 900 (15 min). */
  rateExpirySeconds: number;
  /** Tolerance band in basis points. Default 200 (±2%). */
  toleranceBps: number;
  /** Whether contributions in non-unit assets are allowed at all. Default true. */
  allowCrossAssetContributions: boolean;
}

/** Default FX policy applied when a group does not specify one. */
export const DEFAULT_FX_POLICY: FxPolicy = {
  rateExpirySeconds: 900,
  toleranceBps: 200,
  allowCrossAssetContributions: true,
};

/** Normalization result for an amount converted to the unit of account. */
export interface NormalizedAmount {
  /** Amount in the group's unit-of-account asset. */
  normalized: string;
  /** The locked rate used for the conversion. */
  rate: string;
  /** Source asset the contribution was made in. */
  sourceAsset: AssetRef;
  /** Destination (unit-of-account) asset. */
  destinationAsset: AssetRef;
  /** Whether the rate was still valid at the time of normalization. */
  rateValid: boolean;
}