import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, UpdateDateColumn } from 'typeorm';
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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
