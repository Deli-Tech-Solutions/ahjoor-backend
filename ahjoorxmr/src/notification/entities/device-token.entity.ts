import { Entity, Column, ManyToOne, JoinColumn, Index, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum DevicePlatform {
  FCM = 'fcm',
  APN = 'apn',
}

/**
 * DeviceToken entity stores push notification tokens for users.
 * Supports both FCM (Firebase Cloud Messaging) and APNs (Apple Push Notification service) tokens.
 */
@Entity('device_tokens')
@Index(['userId', 'platform'])
@Index(['token'], { unique: true })
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 255 })
  token: string;

  @Column({
    type: 'enum',
    enum: DevicePlatform,
    default: DevicePlatform.FCM,
  })
  platform: DevicePlatform;

  @Column({ type: 'varchar', length: 255, nullable: true })
  deviceId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  deviceName?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  appVersion?: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date;

  @Column({ type: 'boolean', default: false })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
