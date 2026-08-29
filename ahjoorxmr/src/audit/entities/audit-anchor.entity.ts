import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Append-only store for periodic external anchoring of the audit chain head.
 *
 * Each row records the chain head hash at a point in time, along with an
 * external reference (e.g. a Stellar transaction hash) that makes the anchor
 * tamper-evident outside the database.
 *
 * There are NO update/delete endpoints for this table — it is write-once by
 * design. The `sequence` bigserial UNIQUE column enforces insertion order.
 */
@Entity('audit_anchors')
@Index('idx_audit_anchors_chain', ['chainId', 'chainPartition', 'sequence'])
export class AuditAnchor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  chainId: string;

  @Column({ type: 'varchar', length: 255, default: 'GLOBAL' })
  chainPartition: string;

  /** SHA-256 hex hash (64 chars) of the chain head at anchor time */
  @Column({ type: 'varchar', length: 64 })
  chainHeadHash: string;

  @CreateDateColumn()
  anchoredAt: Date;

  /** 'STELLAR' | 'WRITE_ONCE' */
  @Column({ type: 'varchar', length: 20, default: 'WRITE_ONCE' })
  anchorType: string;

  /** Stellar transaction hash when anchored on-chain */
  @Column({ type: 'varchar', length: 255, nullable: true })
  stellarTxHash: string;

  /** Extra metadata (e.g. ledger sequence, memo) */
  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any>;

  /** Monotonic insertion order enforced by the DB */
  @Column({ type: 'bigint', unique: true, generated: 'increment' })
  sequence: string;
}