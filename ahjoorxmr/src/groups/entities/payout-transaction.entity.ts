import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { PayoutTransactionStatus } from './payout-transaction-status.enum';

@Entity('payout_transactions')
@Index('IDX_payout_transactions_payoutOrderId', ['payoutOrderId'], {
  unique: true,
})
@Index('IDX_payout_transactions_status', ['status'])
export class PayoutTransaction extends BaseEntity {
  @Column('varchar', { length: 255 })
  payoutOrderId!: string;

  @Column({
    type: 'enum',
    enum: PayoutTransactionStatus,
    default: PayoutTransactionStatus.PENDING_SUBMISSION,
  })
  status!: PayoutTransactionStatus;

  @Column('varchar', { length: 255, nullable: true, default: null })
  txHash!: string | null;

  /** Asset code the payout was denominated in (the group's unit of account). */
  @Column({ type: 'varchar', length: 12, default: 'XLM' })
  assetCode!: string;

  /** Stellar issuer of the payout asset. Null for native XLM. */
  @Column({ type: 'varchar', length: 56, nullable: true, default: null })
  assetIssuer!: string | null;

  /** Amount requested at the destination (in the payout asset). */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  requestedAmount!: string | null;

  /** Amount actually delivered (in the payout asset). */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  deliveredAmount!: string | null;

  /** Outcome of the path payment: FULL_FILL | PARTIAL_FILL | SLIPPAGE_EXCEEDED | FAILED. */
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  pathPaymentOutcome!: string | null;

  /** Locked FX rate used for the payout (destination per source). */
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  fxRate!: string | null;

  /** Human-readable reason for non-full-fill outcomes. */
  @Column({ type: 'text', nullable: true, default: null })
  failureReason!: string | null;
}
