import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import {
  AssetRef,
  DEFAULT_FX_POLICY,
  FxPolicy,
  LockedFxRate,
  NormalizedAmount,
} from './fx.types';
import { Group } from '../groups/entities/group.entity';

/**
 * FX service for multi-asset contributions and payouts.
 *
 * Responsibilities:
 *  - Capture and lock an FX rate at contribution submission time.
 *  - Normalize any amount to the group's unit-of-account asset.
 *  - Enforce the group's FX policy (expiry, tolerance band, cross-asset allowance).
 *
 * The rate is captured **at submission time** and honored through settlement,
 * so contributors are not exposed to price movement between submission and
 * on-chain confirmation.
 */
@Injectable()
export class FxService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns the FX policy for a group, falling back to defaults.
   */
  getPolicy(group: Group): FxPolicy {
    return {
      rateExpirySeconds:
        group.fxRateExpirySeconds ?? DEFAULT_FX_POLICY.rateExpirySeconds,
      toleranceBps: group.fxToleranceBps ?? DEFAULT_FX_POLICY.toleranceBps,
      allowCrossAssetContributions:
        group.allowCrossAssetContributions ??
        DEFAULT_FX_POLICY.allowCrossAssetContributions,
    };
  }

  /**
   * Returns the group's unit-of-account asset.
   * This is the asset in which all aggregation, payout math, and penalties
   * are denominated.
   */
  getUnitOfAccount(group: Group): AssetRef {
    return {
      code: (group.unitOfAccountAssetCode ?? group.assetCode ?? 'XLM').toUpperCase(),
      issuer: group.unitOfAccountAssetIssuer ?? group.assetIssuer ?? null,
    };
  }

  /**
   * Returns the asset a contribution was made in.
   * Defaults to the group's unit-of-account if not specified.
   */
  getContributionAsset(group: Group, assetCode?: string, assetIssuer?: string | null): AssetRef {
    return {
      code: (assetCode ?? group.unitOfAccountAssetCode ?? group.assetCode ?? 'XLM').toUpperCase(),
      issuer: assetIssuer ?? group.unitOfAccountAssetIssuer ?? group.assetIssuer ?? null,
    };
  }

  /**
   * Captures and locks an FX rate at contribution submission time.
   *
   * If the contribution asset equals the unit-of-account, the rate is 1:1.
   * Otherwise, the rate is fetched from the configured FX provider and locked
   * with an expiry and tolerance band per the group's policy.
   *
   * @param group - The group the contribution is for.
   * @param sourceAsset - The asset the contributor is paying in.
   * @returns A locked FX rate.
   */
  async lockRate(group: Group, sourceAsset: AssetRef): Promise<LockedFxRate> {
    const destination = this.getUnitOfAccount(group);
    const policy = this.getPolicy(group);

    if (!policy.allowCrossAssetContributions && !this.assetsEqual(sourceAsset, destination)) {
      throw new BadRequestException(
        `Cross-asset contributions are disabled for this group. ` +
          `Contributions must be in ${destination.code}.`,
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + policy.rateExpirySeconds * 1000);

    // Same asset → 1:1 rate, no FX needed.
    if (this.assetsEqual(sourceAsset, destination)) {
      return {
        source: sourceAsset,
        destination,
        rate: '1',
        capturedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        toleranceBps: policy.toleranceBps,
      };
    }

    const rate = await this.fetchRate(sourceAsset, destination);

    return {
      source: sourceAsset,
      destination,
      rate,
      capturedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      toleranceBps: policy.toleranceBps,
    };
  }

  /**
   * Normalizes an amount to the group's unit-of-account asset.
   *
   * @param group - The group.
   * @param amount - The amount in the source asset (string to avoid float issues).
   * @param sourceAsset - The asset the amount is denominated in.
   * @param lockedRate - Optional pre-locked rate. If omitted, a fresh rate is captured.
   * @returns The normalized amount plus metadata.
   */
  async normalizeToUnitOfAccount(
    group: Group,
    amount: string,
    sourceAsset: AssetRef,
    lockedRate?: LockedFxRate,
  ): Promise<NormalizedAmount> {
    const destination = this.getUnitOfAccount(group);

    // If the source is already the unit of account, no conversion needed.
    if (this.assetsEqual(sourceAsset, destination)) {
      return {
        normalized: amount,
        rate: '1',
        sourceAsset,
        destinationAsset: destination,
        rateValid: true,
      };
    }

    // Use the provided locked rate, or capture a fresh one.
    const rate = lockedRate ?? (await this.lockRate(group, sourceAsset));

    const rateValid = this.isRateValid(rate);
    if (!rateValid) {
      throw new BadRequestException(
        `Locked FX rate for ${sourceAsset.code} → ${destination.code} has expired. ` +
          `Please re-submit the contribution to capture a fresh rate.`,
      );
    }

    const amountDecimal = new Decimal(amount);
    const rateDecimal = new Decimal(rate.rate);
    const normalized = amountDecimal.times(rateDecimal).toFixed(7);

    return {
      normalized,
      rate: rate.rate,
      sourceAsset,
      destinationAsset: destination,
      rateValid,
    };
  }

  /**
   * Checks whether a locked rate is still within its validity window.
   */
  isRateValid(rate: LockedFxRate): boolean {
    return new Date(rate.expiresAt).getTime() > Date.now();
  }

  /**
   * Checks whether the effective rate of a path payment is within the
   * tolerance band of the locked rate.
   *
   * @param lockedRate - The rate locked at submission time.
   * @param effectiveRate - The rate actually delivered (destination per source).
   * @returns true if within tolerance, false if slippage exceeded.
   */
  isWithinTolerance(lockedRate: LockedFxRate, effectiveRate: string): boolean {
    const locked = new Decimal(lockedRate.rate);
    const effective = new Decimal(effectiveRate);

    if (locked.isZero()) return false;

    // Deviation as a fraction: |effective - locked| / locked
    const deviation = effective.minus(locked).abs().div(locked);
    const tolerance = new Decimal(lockedRate.toleranceBps).div(10000);

    return deviation.lte(tolerance);
  }

  /**
   * Compares two asset references for equality (code + issuer).
   */
  assetsEqual(a: AssetRef, b: AssetRef): boolean {
    return (
      a.code.toUpperCase() === b.code.toUpperCase() &&
      (a.issuer ?? null) === (b.issuer ?? null)
    );
  }

  /**
   * Fetches the current FX rate from the configured provider.
   *
   * The provider is pluggable via `FX_PROVIDER` env var:
   *  - `oracle` (default): uses a configured oracle endpoint.
   *  - `static`: uses a static rate from `FX_STATIC_RATE` (for testing/dev).
   *
   * @param source - Source asset.
   * @param destination - Destination asset.
   * @returns Rate as a string: 1 source = rate destination.
   */
  private async fetchRate(source: AssetRef, destination: AssetRef): Promise<string> {
    const provider = this.configService.get<string>('FX_PROVIDER', 'oracle');

    if (provider === 'static') {
      const staticRate = this.configService.get<string>('FX_STATIC_RATE');
      if (!staticRate) {
        throw new BadRequestException(
          'FX_STATIC_RATE must be set when FX_PROVIDER=static',
        );
      }
      return staticRate;
    }

    // Oracle provider — fetch from configured endpoint.
    const oracleUrl = this.configService.get<string>('FX_ORACLE_URL');
    if (!oracleUrl) {
      throw new BadRequestException(
        'FX_ORACLE_URL must be set when FX_PROVIDER=oracle',
      );
    }

    try {
      const response = await fetch(
        `${oracleUrl}?from=${encodeURIComponent(source.code)}&to=${encodeURIComponent(destination.code)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) {
        throw new Error(`FX oracle returned ${response.status}`);
      }
      const data = (await response.json()) as { rate?: string | number };
      if (data.rate === undefined) {
        throw new Error('FX oracle response missing "rate"');
      }
      return String(data.rate);
    } catch (error) {
      throw new BadRequestException(
        `Failed to fetch FX rate ${source.code} → ${destination.code}: ${(error as Error).message}`,
      );
    }
  }
}