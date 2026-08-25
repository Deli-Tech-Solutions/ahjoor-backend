import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Webhook } from './webhook.entity';

export enum WebhookDeliveryStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  PENDING = 'PENDING',
}

@Entity('webhook_deliveries')
@Index(['webhookId', 'attemptedAt'])
@Index(['webhookId', 'eventId'], { unique: true })
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  webhookId: string;

  @ManyToOne(() => Webhook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'webhookId' })
  webhook: Webhook;

  @Column({ type: 'varchar', length: 128 })
  eventId: string;

  @Column({ type: 'varchar', length: 50 })
  status: WebhookDeliveryStatus;

  @Column({ type: 'int', nullable: true })
  responseCode: number | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  responseBody: string | null;

  @Column({ type: 'text' })
  payload: string;

  @Column({ type: 'int', default: 1 })
  attemptNumber: number;

  @CreateDateColumn()
  attemptedAt: Date;
}
