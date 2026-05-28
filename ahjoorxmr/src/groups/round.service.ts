import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Group } from '../groups/entities/group.entity';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { Membership } from '../memberships/entities/membership.entity';
import { MembershipStatus } from '../memberships/entities/membership-status.enum';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { PayoutService } from './payout.service';
import { WebhookService, WebhookEventType } from '../webhooks/webhook.service';
import { GroupCompletedPayload } from '../webhooks/interfaces/webhook.interface';

@Injectable()
export class RoundService {
  private readonly logger = new Logger(RoundService.name);

  constructor(
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    private readonly notificationsService: NotificationsService,
    private readonly payoutService: PayoutService,
    private readonly webhookService: WebhookService,
  ) {}

  /**
   * Attempts to advance the group to the next round.
   * No-ops silently when the group is not ACTIVE or when any member has not yet paid.
   * Transitions the group to COMPLETED when currentRound exceeds totalRounds.
   * Emits ROUND_OPENED notifications to all members on a successful advance.
   *
   * @returns true when the round was advanced, false when conditions were not met
   */
  async tryAdvanceRound(groupId: string): Promise<boolean> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group || group.status !== GroupStatus.ACTIVE) {
      return false;
    }

    const memberships = await this.membershipRepository.find({
      where: { groupId, status: MembershipStatus.ACTIVE },
    });

    if (memberships.length === 0) {
      return false;
    }

    const allPaid = memberships.every((m) => m.hasPaidCurrentRound);
    if (!allPaid) {
      this.logger.debug(
        `Group ${groupId} round ${group.currentRound}: not all members have paid, skipping advance`,
      );
      return false;
    }

    group.currentRound += 1;
    group.staleAt = null;

    const roundToPayout = group.currentRound - 1; // Payout for the round that just finished

    if (group.currentRound > group.totalRounds) {
      group.status = GroupStatus.COMPLETED;
      await this.groupRepository.save(group);
      this.logger.log(
        `Group ${groupId} completed after ${group.totalRounds} rounds`,
      );

      // Dispatch GROUP_COMPLETED webhook event
      try {
        const payload: GroupCompletedPayload = {
          groupId,
          totalRounds: group.totalRounds,
          completedAt: new Date().toISOString(),
        };
        await this.webhookService.dispatchEvent(WebhookEventType.GROUP_COMPLETED, payload);
        this.logger.log(`Dispatched GROUP_COMPLETED webhook for group ${groupId}`);
      } catch (error) {
        this.logger.error(
          `Failed to dispatch GROUP_COMPLETED webhook for group ${groupId}: ${(error as Error).message}`,
          (error as Error).stack,
        );
      }

      // Trigger payout for the last round
      try {
        await this.payoutService.distributePayout(groupId, roundToPayout);
      } catch (error) {
        this.logger.error(
          `Failed to distribute payout for last round ${roundToPayout} in group ${groupId}: ${error.message}`,
          error.stack,
        );
      }

      return true;
    }

    // Reset payment flags for the new round
    await this.membershipRepository.update(
      { groupId, status: MembershipStatus.ACTIVE },
      { hasPaidCurrentRound: false },
    );

    await this.groupRepository.save(group);

    this.logger.log(`Group ${groupId} advanced to round ${group.currentRound}`);

    // Trigger payout for the completed round
    try {
      await this.payoutService.distributePayout(groupId, roundToPayout);
    } catch (error) {
      this.logger.error(
        `Failed to distribute payout for round ${roundToPayout} in group ${groupId}: ${error.message}`,
        error.stack,
      );
    }

    // Notify all members — fire-and-forget, never block the caller
    const notifications = memberships.map((m) => ({
      userId: m.userId,
      type: NotificationType.ROUND_OPENED,
      title: 'New Round Started',
      body: `Round ${group.currentRound} has started for group "${group.name}"`,
      metadata: { groupId: group.id, round: group.currentRound },
      idempotencyKey: `${group.id}-${group.currentRound}-${m.userId}-ROUND_OPENED`,
    }));

    this.notificationsService.notifyBatch(notifications).catch((err) => {
      this.logger.error(
        `Failed to send ROUND_OPENED notifications for group ${groupId}: ${err.message}`,
        err.stack,
      );
    });

    return true;
  }
}
