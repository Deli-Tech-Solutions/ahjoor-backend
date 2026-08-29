import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Audit log entity.
 *
 * Index strategy (see migration 1743210000000-AddAuditLogIndexes):
 *  - idx_audit_user_id      : single-column on userId
 *  - idx_audit_resource     : single-column on resource
 *  - idx_audit_created_at   : single-column on timestamp DESC
 *  - idx_audit_user_created : composite (userId, timestamp DESC) for
 *                             "recent activity for a user" queries
 *
 * Tamper evidence (see migration 1750000000000-AddTamperEvidenceToAuditLogs):
 *  - hash / prevHash / chainId / chainPartition / chainVersion form a hash
 *    chain so any retroactive edit or delete breaks the chain and is detected
 *    by the integrity verification job.
 *  - anchorReference stores the external anchor (e.g. Stellar tx hash) for the
 *    periodic chain-head anchoring.
 */
@Entity('audit_logs')
@Index('idx_audit_user_id', ['userId'])
@Index('idx_audit_resource', ['resource'])
@Index('idx_audit_created_at', ['timestamp'])
@Index('idx_audit_user_created', ['userId', 'timestamp'])
@Index('idx_audit_chain', ['chainId', 'chainPartition', 'timestamp', 'id'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  userId: string;

  @Column()
  action: string;

  @Column()
  resource: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  timestamp: Date;

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ type: 'text', nullable: true })
  userAgent: string;

  @Column({ type: 'jsonb', nullable: true })
  requestPayload: Record<string, any>;

  // ── Tamper-evidence (hash chain) ────────────────────────────────────────────
  /** SHA-256 hex hash (64 chars) of this row's content plus the previous hash */
  @Column({ type: 'varchar', length: 64, nullable: true })
  hash: string;

  /** SHA-256 hex hash (64 chars) of the previous row in the chain ('' for first row) */
  @Column({ type: 'varchar', length: 64, nullable: true })
  prevHash: string;

  /** Stable UUID identifying the chain (all rows in the same chain share it) */
  @Column({ type: 'varchar', length: 64, nullable: true })
  chainId: string;

  /** Partition key for per-entity-stream chains (default 'GLOBAL') */
  @Column({ type: 'varchar', length: 255, nullable: true, default: 'GLOBAL' })
  chainPartition: string;

  /** Bumped when a legitimate schema migration/backfill changes canonical content */
  @Column({ type: 'integer', nullable: true, default: 1 })
  chainVersion: number;

  /** External anchor reference (e.g. Stellar transaction hash) */
  @Column({ type: 'varchar', length: 255, nullable: true })
  anchorReference: string;
}