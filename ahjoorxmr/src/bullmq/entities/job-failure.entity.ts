import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type JobFailureStatus = 'PENDING' | 'RETRYING' | 'RESOLVED' | 'POISON';

@Entity('job_failures')
@Index(['queueName', 'failedAt'])
@Index(['jobName'])
@Index(['status'])
export class JobFailure {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { length: 255 })
  jobId: string;

  @Column('varchar', { length: 255 })
  jobName: string;

  @Column('varchar', { length: 255 })
  queueName: string;

  @CreateDateColumn({ type: 'timestamptz' })
  failedAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('text')
  error: string;

  @Column('text', { nullable: true })
  stackTrace: string | null;

  @Column('int', { default: 1 })
  attemptNumber: number;

  @Column('jsonb', { nullable: true })
  data: Record<string, unknown> | null;

  @Column('int', { default: 0 })
  retryCount: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'PENDING',
  })
  status: JobFailureStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastRetriedAt: Date | null;

  /** Set to true when the job was classified as a poison message */
  @Column('boolean', { default: false })
  isPoison: boolean;

  /** Number of consecutive failures with the same error signature */
  @Column('int', { default: 0 })
  consecutiveFailures: number;

  /** SHA-256 signature of (errorClass + payload) used for poison detection */
  @Column('varchar', { length: 64, nullable: true })
  failureSignature: string | null;

  /** Error class name (e.g. 'Error', 'ServiceUnavailableException') */
  @Column('varchar', { length: 128, nullable: true })
  errorClass: string | null;
}