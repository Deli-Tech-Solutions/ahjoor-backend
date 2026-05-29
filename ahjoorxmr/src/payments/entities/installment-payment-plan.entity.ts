import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

export enum InstallmentPlanStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  PAUSED = 'PAUSED',
}

@Entity('installment_payment_plans')
export class InstallmentPaymentPlan extends BaseEntity {
  @Column('uuid')
  customerId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'customerId' })
  customer: User;

  @Column('uuid')
  merchantId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'merchantId' })
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

  @Column('int')
  nextDueLedger: number;

  @Column('int')
  expiryLedger: number;

  @Column({
    type: 'enum',
    enum: InstallmentPlanStatus,
    enumName: 'installment_plan_status',
    default: InstallmentPlanStatus.ACTIVE,
  })
  status: InstallmentPlanStatus;

  @Column('decimal', { precision: 36, scale: 18, array: true })
  installmentAmounts: string[];

  @Column({ default: false })
  paused: boolean;

  @Column('text', { array: true, default: () => "'{}'" })
  settlementTransactionHashes: string[];

  @Column('decimal', { precision: 36, scale: 18, nullable: true })
  lastSettledAmount?: string | null;
}
