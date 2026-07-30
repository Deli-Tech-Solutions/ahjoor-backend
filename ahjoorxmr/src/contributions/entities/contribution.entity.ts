import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Group } from '../../groups/entities/group.entity';
import { User } from '../../users/entities/user.entity';

export enum ContributionStatus {
  PENDING = 'PENDING',
  ON_CHAIN_SUBMITTED = 'ON_CHAIN_SUBMITTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

/**
 * Contribution entity representing a member's on-chain contribution to a ROSCA group.
 * Tracks contribution details including amount, round number, and blockchain transaction hash.
 */
@Entity('contributions')
@Unique(['transactionHash'])
@Unique(['userId', 'groupId', 'roundNumber'])
export class Contribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  groupId: string;

  @ManyToOne(() => Group)
  @JoinColumn({ name: 'groupId' })
  group: Group;

  @Column('uuid')
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('varchar', { length: 255 })
  walletAddress: string;

  @Column('int')
  roundNumber: number;

  @Column('varchar', { length: 255 })
  amount: string;

  @Column('varchar', { length: 255 })
  @Index()
  transactionHash: string;

  @Column('timestamp')
  timestamp: Date;

  /** Asset code used for this contribution (e.g. 'XLM', 'USDC'). Copied from group at contribution time. */
  @Column({ type: 'varchar', length: 12, default: 'XLM' })
  assetCode: string;

  /** Stellar issuer account for the asset. Null for native XLM. */
  @Column({ type: 'varchar', length: 56, nullable: true, default: null })
  assetIssuer: string | null;

  @Column({ type: 'enum', enum: ContributionStatus, default: ContributionStatus.PENDING })
  status: ContributionStatus;

  /** Client-supplied idempotency key (UUID v4). Used to deduplicate concurrent retries. */
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  @Index({ unique: true, where: '"idempotencyKey" IS NOT NULL' })
  idempotencyKey: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
