import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { GroupWaitlist, WaitlistStatus } from './entities/group-waitlist.entity';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { MembershipStatus } from '../memberships/entities/membership-status.enum';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { WinstonLogger } from '../common/logger/winston.logger';

@Injectable()
export class WaitlistService {
  private readonly maxWaitlist: number;

  constructor(
    @InjectRepository(GroupWaitlist)
    private readonly waitlistRepo: Repository<GroupWaitlist>,
    @InjectRepository(Group)
    private readonly groupRepo: Repository<Group>,
    @InjectRepository(Membership)
    private readonly membershipRepo: Repository<Membership>,
    private readonly dataSource: DataSource,
    private readonly notificationsService: NotificationsService,
    private readonly logger: WinstonLogger,
    configService: ConfigService,
  ) {
    this.maxWaitlist = configService.get<number>('GROUP_MAX_WAITLIST', 50);
  }

  async joinWaitlist(
    groupId: string,
    userId: string,
    walletAddress: string,
  ): Promise<{ position: number }> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');

    const isMember = await this.membershipRepo.findOne({ where: { groupId, userId } });
    if (isMember) throw new ConflictException('User is already a member of this group');

    const existing = await this.waitlistRepo.findOne({
      where: { groupId, userId, status: WaitlistStatus.WAITING },
    });
    if (existing) throw new ConflictException('User is already on the waitlist');

    const memberCount = await this.membershipRepo.count({ where: { groupId } });
    if (memberCount < group.maxMembers) {
      throw new BadRequestException('Group is not full; join directly as a member');
    }

    const waitlistCount = await this.waitlistRepo.count({
      where: { groupId, status: WaitlistStatus.WAITING },
    });
    if (waitlistCount >= this.maxWaitlist) {
      throw new BadRequestException(`Waitlist is full (max ${this.maxWaitlist} users)`);
    }

    const position = waitlistCount + 1;
    const entry = this.waitlistRepo.create({
      groupId,
      userId,
      walletAddress,
      position,
      status: WaitlistStatus.WAITING,
    });
    await this.waitlistRepo.save(entry);

    this.logger.log(
      `User ${userId} joined waitlist for group ${groupId} at position ${position}`,
      'WaitlistService',
    );
    return { position };
  }

  async leaveWaitlist(groupId: string, userId: string): Promise<void> {
    const entry = await this.waitlistRepo.findOne({
      where: { groupId, userId, status: WaitlistStatus.WAITING },
    });
    if (!entry) throw new NotFoundException('Waitlist entry not found');

    const cancelledPosition = entry.position;
    entry.status = WaitlistStatus.CANCELLED;
    await this.waitlistRepo.save(entry);

    // Re-sequence positions for users behind the cancelled entry in one UPDATE
    await this.waitlistRepo
      .createQueryBuilder()
      .update(GroupWaitlist)
      .set({ position: () => '"position" - 1' })
      .where('"groupId" = :groupId AND status = :status AND position > :pos', {
        groupId,
        status: WaitlistStatus.WAITING,
        pos: cancelledPosition,
      })
      .execute();

    this.logger.log(`User ${userId} left waitlist for group ${groupId}`, 'WaitlistService');
  }

  async getMyPosition(
    groupId: string,
    userId: string,
  ): Promise<{ position: number; status: WaitlistStatus }> {
    const entry = await this.waitlistRepo.findOne({
      where: { groupId, userId },
      order: { createdAt: 'DESC' },
    });
    if (!entry) throw new NotFoundException('No waitlist entry found for this user');
    return { position: entry.position, status: entry.status };
  }

  async getWaitlist(groupId: string, requestingUserId: string): Promise<GroupWaitlist[]> {
    const group = await this.groupRepo.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');

    const requestingMembership = await this.membershipRepo.findOne({
      where: { groupId, userId: requestingUserId },
    });
    if (!requestingMembership) throw new ForbiddenException('Not a group member');
    if (group.adminWallet !== requestingMembership.walletAddress) {
      throw new ForbiddenException('Only the group admin can view the waitlist');
    }

    return this.waitlistRepo.find({
      where: { groupId, status: WaitlistStatus.WAITING },
      relations: ['user'],
      order: { position: 'ASC' },
    });
  }

  /**
   * Admits the first WAITING user from the waitlist into the group atomically.
   * Uses a pessimistic write lock to prevent double-admission under concurrency.
   */
  async admitNextFromWaitlist(groupId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const next = await manager.findOne(GroupWaitlist, {
        where: { groupId, status: WaitlistStatus.WAITING },
        order: { position: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!next) return;

      const group = await manager.findOne(Group, { where: { id: groupId } });
      if (!group) return;

      const memberCount = await manager.count(Membership, { where: { groupId } });
      if (memberCount >= group.maxMembers) return;

      const result = await manager
        .createQueryBuilder(Membership, 'm')
        .select('MAX(m.payoutOrder)', 'maxOrder')
        .where('m.groupId = :groupId', { groupId })
        .getRawOne();
      const maxOrder = result?.maxOrder;
      const payoutOrder = maxOrder !== null && maxOrder !== undefined ? maxOrder + 1 : 0;

      const membership = manager.create(Membership, {
        groupId,
        userId: next.userId,
        walletAddress: next.walletAddress,
        payoutOrder,
        status: MembershipStatus.ACTIVE,
        hasReceivedPayout: false,
        hasPaidCurrentRound: false,
      });
      await manager.save(Membership, membership);

      next.status = WaitlistStatus.ADMITTED;
      await manager.save(GroupWaitlist, next);

      this.logger.log(
        `User ${next.userId} admitted from waitlist into group ${groupId}`,
        'WaitlistService',
      );

      setImmediate(() =>
        this.notificationsService
          .notify({
            userId: next.userId,
            type: NotificationType.WAITLIST_ADMITTED,
            title: 'You have been admitted to the group',
            body: `A spot opened up in "${group.name}" and you have been admitted.`,
            metadata: { groupId, groupName: group.name },
          })
          .catch((err) =>
            this.logger.error(
              `Failed to send WAITLIST_ADMITTED notification: ${err.message}`,
              err.stack,
              'WaitlistService',
            ),
          ),
      );
    });
  }
}
