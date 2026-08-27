import { Entity, Column, OneToMany, DeleteDateColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { GroupStatus } from './group-status.enum';
import { PayoutOrderStrategy } from './payout-order-strategy.enum';
import { Membership } from '../../memberships/entities/membership.entity';

/**
 * Group entity representing a ROSCA savings group.
 * Mirrors the on-chain group state and serves as the source of truth for the API.
 */
@Entity('groups')
export class Group extends BaseEntity {
  @Column('varchar', { length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  contractAddress: string | null;

  @Column('varchar', { length: 255 })
  adminWallet: string;

  @Column('varchar', { length: 100 })
  contributionAmount: string;

  @Column('varchar', { length: 255 })
  token: string;

  /**
   * Stellar asset code for contributions/payouts (e.g. 'XLM', 'USDC').
   * Defaults to 'XLM' (native asset). Max 12 chars per Stellar spec.
   */
  @Column({ type: 'varchar', length: 12, default: 'XLM' })
  assetCode: string;

  /**
   * Stellar account ID of the asset issuer.
   * Null for native XLM. Required for any non-XLM asset.
   */
  @Column({ type: 'varchar', length: 56, nullable: true, default: null })
  assetIssuer: string | null;

  /**
   * Unit-of-account asset code — the asset in which all aggregation,
   * payout math, and penalties are denominated. Defaults to assetCode.
   * When a group is denominated in USDC but members contribute in XLM,
   * this is the asset the XLM is converted into.
   */
  @Column({ type: 'varchar', length: 12, default: 'XLM' })
  unitOfAccountAssetCode: string;

  /**
   * Stellar account ID of the unit-of-account asset issuer.
   * Null for native XLM.
   */
  @Column({ type: 'varchar', length: 56, nullable: true, default: null })
  unitOfAccountAssetIssuer: string | null;

  /**
   * FX rate lock expiry in seconds. A rate captured at contribution
   * submission time is honored for this long. Default 900 (15 min).
   */
  @Column('int', { default: 900 })
  fxRateExpirySeconds: number;

  /**
   * FX tolerance band in basis points (1 bp = 0.01%). Default 200 (±2%).
   * If the effective path-payment rate deviates beyond this from the
   * locked rate, the payment is rejected as slippage-exceeded.
   */
  @Column('int', { default: 200 })
  fxToleranceBps: number;

  /**
   * Whether contributions in assets other than the unit-of-account are
   * allowed. Default true.
   */
  @Column('boolean', { default: true })
  allowCrossAssetContributions: boolean;

  @Column('int')
  roundDuration: number;

  @Column({
    type: 'enum',
    enum: GroupStatus,
    default: GroupStatus.PENDING,
  })
  status: GroupStatus;

  @Column('int', { default: 0 })
  currentRound: number;

  @Column('int')
  totalRounds: number;

  @Column({
    type: 'enum',
    enum: PayoutOrderStrategy,
    default: PayoutOrderStrategy.SEQUENTIAL,
  })
  payoutOrderStrategy: PayoutOrderStrategy;

  @Column('int')
  minMembers: number;

  @Column('int')
  maxMembers: number;

  @Column({ type: 'timestamp', nullable: true, default: null })
  staleAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  startDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  endDate: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: 'UTC' })
  timezone: string | null;

  @Column('decimal', { precision: 5, scale: 4, default: 0.05 })
  penaltyRate: number;

  @Column('int', { default: 24 })
  gracePeriodHours: number;

  @DeleteDateColumn({ nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => Membership, (membership) => membership.group)
  memberships: Membership[];
}
