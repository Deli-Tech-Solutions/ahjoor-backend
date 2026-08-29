import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum InstallmentPlanStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  PAUSED = 'PAUSED',
}

@Entity()
export class InstallmentPaymentPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { nullable: false })
  customer: User;

  @ManyToOne(() => User, { nullable: false })
  merchant: User;

  @Column()
  token: string;

  @Column('decimal', { precision: 36, scale: 18 })
  totalAmount: string;

  @Column('int')
  numInstallments: number;

  @Column('int')
  intervalLedgers: number;

  @Column('int')
  currentInstallment: number;

  /**
   * Next installment due ledger. Shifted forward by paused duration on each
   * resume so the penalty accrual clock resumes from where it left off.
   */
  @Column('int')
  nextDueLedger: number;

  @Column('int')
  expiryLedger: number;

  @Column({ type: 'enum', enum: InstallmentPlanStatus, default: InstallmentPlanStatus.ACTIVE })
  status: InstallmentPlanStatus;

  @Column('decimal', { precision: 36, scale: 18, array: true })
  installmentAmounts: string[];

  @Column({ default: false })
  paused: boolean;

  /** Ledger at which the current pause began; null when not paused. */
  @Column({ type: 'int', nullable: true })
  pausedAtLedger: number | null;

  /** Wall-clock start of the current pause; null when not paused. */
  @Column({ type: 'timestamptz', nullable: true })
  pausedAt: Date | null;

  /** Cumulative ledgers spent paused across all pause/resume cycles. */
  @Column({ type: 'int', default: 0 })
  totalPausedLedgers: number;

  /** Number of times this plan has been paused (lifetime). */
  @Column({ type: 'int', default: 0 })
  pauseCount: number;

  /** Ledger at which the plan was last resumed; used for pause cooldown. */
  @Column({ type: 'int', nullable: true })
  lastResumedAtLedger: number | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
