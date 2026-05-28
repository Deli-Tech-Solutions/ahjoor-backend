import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Group } from '../group.entity';
import { User } from '../../../users/entities/user.entity';

export enum InviteStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  EXHAUSTED = 'EXHAUSTED',
}

@Entity('group_invites')
@Index(['status', 'expiresAt'])
export class GroupInvite extends BaseEntity {
  @Column({ type: 'uuid' })
  groupId: string;

  @ManyToOne(() => Group)
  @JoinColumn({ name: 'groupId' })
  group: Group;

  @Column({ type: 'uuid' })
  createdBy: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'createdBy' })
  creator: User;

  @Column({ type: 'varchar', length: 12, unique: true })
  @Index()
  code: string;

  @Column({ type: 'int', default: 1 })
  maxUses: number;

  @Column({ type: 'int', default: 0 })
  usedCount: number;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({
    type: 'enum',
    enum: InviteStatus,
    default: InviteStatus.ACTIVE,
  })
  status: InviteStatus;
}
