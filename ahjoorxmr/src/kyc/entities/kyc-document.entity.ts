import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { encryptedTransformer } from '../../common/encryption/field-encryption.transformer';
import { KycStatus } from './kyc-status.enum';
import { KycProvider } from '../enums/kyc-provider.enum';

@Entity('kyc_documents')
@Index(['userId'])
@Index(['status', 'lastProviderEventAt'])
export class KycDocument extends BaseEntity {
  @Column('uuid')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column('varchar', { length: 500 })
  storageKey: string;

  @Column('varchar', { length: 500 })
  url: string;

  @Column('varchar', { length: 100 })
  mimeType: string;

  @Column('int')
  fileSize: number;

  @Column('varchar', { length: 255 })
  originalName: string;

  @Column({ type: 'varchar', length: 500, nullable: true, transformer: encryptedTransformer })
  documentNumber?: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  uploadedAt: Date;

  @Column({ type: 'varchar', length: 20, nullable: true })
  provider: KycProvider | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index()
  providerCaseId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  providerStatus: string | null;

  @Column({ type: 'varchar', length: 20, default: KycStatus.PENDING })
  status: KycStatus;

  @Column({ type: 'jsonb', nullable: true })
  providerPayload: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastProviderEventAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  caseExpiresAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  stuckFlaggedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  documentSetHash: string | null;
}
