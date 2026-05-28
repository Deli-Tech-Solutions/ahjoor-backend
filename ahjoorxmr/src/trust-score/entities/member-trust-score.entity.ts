import {
  Entity,
  Column,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * MemberTrustScore entity stores the aggregated, cross-group trust score
 * for a user based on their full payment history across all ROSCA groups.
 *
 * Score is in the range [0, 100] and is recalculated nightly by a BullMQ job.
 */
@Entity('member_trust_scores')
@Index(['userId'], { unique: true })
export class MemberTrustScore extends BaseEntity {
  @Column('uuid')
  @Index()
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Aggregated trust score in the range [0, 100].
   * Null until the first nightly calculation has run.
   */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  score: number;

  /** Total number of distinct groups the user has participated in. */
  @Column({ type: 'int', default: 0 })
  totalGroupsParticipated: number;

  /** Contributions submitted on or before the round deadline. */
  @Column({ type: 'int', default: 0 })
  onTimeContributions: number;

  /** Contributions submitted after the round deadline (but still submitted). */
  @Column({ type: 'int', default: 0 })
  lateContributions: number;

  /** Rounds where no contribution was ever submitted. */
  @Column({ type: 'int', default: 0 })
  missedContributions: number;

  /** Total number of penalties ever incurred. */
  @Column({ type: 'int', default: 0 })
  penaltiesIncurred: number;

  /** Number of incurred penalties that have been paid. */
  @Column({ type: 'int', default: 0 })
  penaltiesPaid: number;

  /** Groups where the user participated through all rounds to completion. */
  @Column({ type: 'int', default: 0 })
  groupsCompletedSuccessfully: number;

  /** Timestamp of the most recent score calculation. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastCalculatedAt: Date | null;
}
