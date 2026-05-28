import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError, In } from 'typeorm';
import { Membership } from './entities/membership.entity';
import { Group } from '../groups/entities/group.entity';
import { WinstonLogger } from '../common/logger/winston.logger';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdatePayoutOrderDto } from './dto/update-payout-order.dto';
import { MembershipStatus } from './entities/membership-status.enum';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { WaitlistService } from '../waitlist/waitlist.service';
import { MemberTrustScore } from '../trust-score/entities/member-trust-score.entity';

/**
 * Service responsible for managing membership operations in ROSCA groups.
 * Handles business logic for adding, removing, and listing group members.
 */
@Injectable()
export class MembershipsService {
  constructor(
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(MemberTrustScore)
    private readonly trustScoreRepository: Repository<MemberTrustScore>,
    private readonly logger: WinstonLogger,
    private readonly notificationsService: NotificationsService,
    private readonly waitlistService: WaitlistService,
  ) {}

  /**
   * Validates that a group exists and is not in ACTIVE status.
   * Membership modifications are only allowed before a group becomes active.
   *
   * @param groupId - The UUID of the group to validate
   * @throws NotFoundException if the group doesn't exist
   * @throws BadRequestException if the group is already active
   * @private
   */
  private async validateGroupNotActive(groupId: string): Promise<Group> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      this.logger.warn(`Group ${groupId} not found`, 'MembershipsService');
      throw new NotFoundException('Group not found');
    }

    if (group.status === 'ACTIVE') {
      this.logger.warn(
        `Attempted to modify memberships for active group ${groupId}`,
        'MembershipsService',
      );
      throw new BadRequestException(
        'Cannot modify memberships for an active group',
      );
    }

    return group;
  }

  /**
   * Calculates the next available payout order position for a new member.
   * Returns 0 if this is the first member, otherwise returns max(payoutOrder) + 1.
   * Returns null if the group uses RANDOM or ADMIN_DEFINED strategy.
   *
   * @param groupId - The UUID of the group
   * @returns The next sequential payout order position or null
   * @private
   */
  private async getNextPayoutOrder(groupId: string): Promise<number | null> {
    // Get the group to check its payout order strategy
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    // For RANDOM or ADMIN_DEFINED strategies, return null
    // Payout order will be assigned at activation time
    if (
      group.payoutOrderStrategy === 'RANDOM' ||
      group.payoutOrderStrategy === 'ADMIN_DEFINED'
    ) {
      return null;
    }

    // For SEQUENTIAL strategy, calculate next order
    const result = await this.membershipRepository
      .createQueryBuilder('membership')
      .select('MAX(membership.payoutOrder)', 'maxOrder')
      .where('membership.groupId = :groupId', { groupId })
      .getRawOne();

    const maxOrder = result?.maxOrder;
    return maxOrder !== null && maxOrder !== undefined ? maxOrder + 1 : 0;
  }

  /**
   * Adds a new member to a ROSCA group.
   * Validates that the group exists and is not active, checks for duplicate membership,
   * assigns the next available payout order, and creates the membership record.
   *
   * @param groupId - The UUID of the group to add the member to
   * @param createMembershipDto - The membership data (userId and walletAddress)
   * @returns The created Membership entity
   * @throws BadRequestException if the group is active or doesn't exist
   * @throws ConflictException if the user is already a member of the group
   */
  async addMember(
    groupId: string,
    createMembershipDto: CreateMembershipDto,
  ): Promise<Membership> {
    const { userId, walletAddress } = createMembershipDto;

    this.logger.log(
      `Adding member ${userId} to group ${groupId}`,
      'MembershipsService',
    );

    try {
      // Validate group exists and is not active
      const group = await this.validateGroupNotActive(groupId);

      // Enforce maxMembers cap
      const memberCount = await this.membershipRepository.count({
        where: { groupId },
      });

      if (memberCount >= group.maxMembers) {
        this.logger.warn(
          `Group ${groupId} is at capacity (${memberCount}/${group.maxMembers})`,
          'MembershipsService',
        );
        throw new BadRequestException(
          `Group has reached its maximum member capacity of ${group.maxMembers}`,
        );
      }

      // Check for duplicate membership
      const existingMembership = await this.membershipRepository.findOne({
        where: { groupId, userId },
      });

      if (existingMembership) {
        this.logger.warn(
          `User ${userId} is already a member of group ${groupId}`,
          'MembershipsService',
        );
        throw new ConflictException('User is already a member of this group');
      }

      // Calculate next available payout order (null for RANDOM/ADMIN_DEFINED)
      const payoutOrder = await this.getNextPayoutOrder(groupId);

      // Create membership with default values
      const membership = this.membershipRepository.create({
        groupId,
        userId,
        walletAddress,
        payoutOrder: payoutOrder as any, // Allow null for non-SEQUENTIAL strategies
        status: MembershipStatus.ACTIVE,
        hasReceivedPayout: false,
        hasPaidCurrentRound: false,
      });

      // Save to database
      const savedMembership = await this.membershipRepository.save(membership);

      this.logger.log(
        `Member ${userId} added to group ${groupId} with membership id ${savedMembership.id}`,
        'MembershipsService',
      );

      return savedMembership;
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      // Handle database errors
      if (error instanceof QueryFailedError) {
        const pgError = error as any;

        // Unique constraint violation (duplicate membership)
        if (pgError.code === '23505') {
          this.logger.error(
            `Unique constraint violation when adding member ${userId} to group ${groupId}`,
            error.stack,
            'MembershipsService',
          );
          throw new ConflictException('User is already a member of this group');
        }

        // Foreign key violation (invalid groupId or userId)
        if (pgError.code === '23503') {
          this.logger.error(
            `Foreign key violation when adding member ${userId} to group ${groupId}`,
            error.stack,
            'MembershipsService',
          );
          throw new BadRequestException('Invalid groupId or userId');
        }
      }

      // Log and re-throw unexpected errors
      this.logger.error(
        `Failed to add member ${userId} to group ${groupId}: ${error.message}`,
        error.stack,
        'MembershipsService',
      );
      throw error;
    }
  }

  /**
   * Removes a member from a ROSCA group.
   * Validates that the group exists and is not active, finds the membership,
   * and deletes it from the database.
   *
   * @param groupId - The UUID of the group to remove the member from
   * @param userId - The UUID of the user to remove
   * @throws BadRequestException if the group is active
   * @throws NotFoundException if the membership doesn't exist
   */
  async removeMember(groupId: string, userId: string): Promise<void> {
    this.logger.log(
      `Removing member ${userId} from group ${groupId}`,
      'MembershipsService',
    );

    try {
      // Validate group exists and is not active
      await this.validateGroupNotActive(groupId);

      // Find membership by groupId and userId
      const membership = await this.membershipRepository.findOne({
        where: { groupId, userId },
      });

      // Throw NotFoundException if membership doesn't exist
      if (!membership) {
        this.logger.warn(
          `Membership not found for user ${userId} in group ${groupId}`,
          'MembershipsService',
        );
        throw new NotFoundException('Membership not found');
      }

      // Delete membership from database
      await this.membershipRepository.remove(membership);

      this.logger.log(
        `Member ${userId} removed from group ${groupId} with membership id ${membership.id}`,
        'MembershipsService',
      );

      // Admit next waitlisted user if one exists
      setImmediate(() =>
        this.waitlistService.admitNextFromWaitlist(groupId).catch((err) =>
          this.logger.error(
            `Failed to admit from waitlist after removal in group ${groupId}: ${err.message}`,
            err.stack,
            'MembershipsService',
          ),
        ),
      );
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      // Log and re-throw unexpected errors
      this.logger.error(
        `Failed to remove member ${userId} from group ${groupId}: ${error.message}`,
        error.stack,
        'MembershipsService',
      );
      throw error;
    }
  }

  /**
   * Lists members of a ROSCA group with pagination.
   * Returns memberships ordered by payout order, enriched with each member's trust score.
   *
   * @param groupId - The UUID of the group to list members for
   * @param page - Page number (1-indexed, default 1)
   * @param limit - Items per page (default 20, max 100)
   * @returns Paginated result with data (including trustScore), total, page, and limit
   */
  async listMembers(
    groupId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: (Membership & { trustScore: number | null })[]; total: number; page: number; limit: number }> {
    this.logger.log(
      `Listing members for group ${groupId} page=${page} limit=${limit}`,
      'MembershipsService',
    );

    try {
      const skip = (page - 1) * limit;
      const [memberships, total] = await this.membershipRepository.findAndCount({
        where: { groupId },
        order: { payoutOrder: 'ASC' },
        skip,
        take: limit,
      });

      // Fetch trust scores for all members in one query
      const userIds = memberships.map((m) => m.userId);
      const trustScores =
        userIds.length > 0
          ? await this.trustScoreRepository.find({
              where: { userId: In(userIds) },
              select: ['userId', 'score'],
            })
          : [];

      const trustScoreMap = new Map<string, number>(
        trustScores.map((ts) => [ts.userId, Number(ts.score)]),
      );

      const data = memberships.map((m) => ({
        ...m,
        trustScore: trustScoreMap.has(m.userId)
          ? trustScoreMap.get(m.userId)!
          : null,
      }));

      this.logger.log(
        `Found ${total} members for group ${groupId}; returning page ${page}`,
        'MembershipsService',
      );

      return { data, total, page, limit };
    } catch (error) {
      this.logger.error(
        `Failed to list members for group ${groupId}: ${error.message}`,
        error.stack,
        'MembershipsService',
      );
      throw error;
    }
  }

  /**
   * Allows a member to leave a PENDING group (self-service).
   * Validates that the group is PENDING, finds the membership,
   * removes it, and re-sequences the payoutOrder for remaining members.
   *
   * @param groupId - The UUID of the group to leave
   * @param userId - The UUID of the user leaving
   * @throws BadRequestException if the group is ACTIVE or COMPLETED
   * @throws NotFoundException if the group or membership doesn't exist
   */
  async leaveGroup(groupId: string, userId: string): Promise<void> {
    this.logger.log(
      `User ${userId} attempting to leave group ${groupId}`,
      'MembershipsService',
    );

    try {
      // Find the group
      const group = await this.groupRepository.findOne({
        where: { id: groupId },
      });

      if (!group) {
        this.logger.warn(`Group ${groupId} not found`, 'MembershipsService');
        throw new NotFoundException('Group not found');
      }

      // Validate group is PENDING
      if (group.status !== GroupStatus.PENDING) {
        this.logger.warn(
          `User ${userId} attempted to leave non-PENDING group ${groupId} (status: ${group.status})`,
          'MembershipsService',
        );
        throw new BadRequestException(
          'Cannot leave a group that is ACTIVE or COMPLETED',
        );
      }

      // Find membership by groupId and userId
      const membership = await this.membershipRepository.findOne({
        where: { groupId, userId },
      });

      if (!membership) {
        this.logger.warn(
          `Membership not found for user ${userId} in group ${groupId}`,
          'MembershipsService',
        );
        throw new NotFoundException('Membership not found');
      }

      const departingPayoutOrder = membership.payoutOrder;

      // Delete membership from database
      await this.membershipRepository.remove(membership);

      // Admit next waitlisted user if one exists
      setImmediate(() =>
        this.waitlistService.admitNextFromWaitlist(groupId).catch((err) =>
          this.logger.error(
            `Failed to admit from waitlist after leave in group ${groupId}: ${err.message}`,
            err.stack,
            'MembershipsService',
          ),
        ),
      );

      // Re-sequence payoutOrder for remaining members
      const remainingMembers = await this.membershipRepository.find({
        where: { groupId },
        order: { payoutOrder: 'ASC' },
      });

      // Update payout order for members that came after the departing member
      for (const member of remainingMembers) {
        if (member.payoutOrder > departingPayoutOrder) {
          member.payoutOrder -= 1;
          await this.membershipRepository.save(member);
        }
      }

      // Send notification to the departing member
      await this.notificationsService.notify({
        userId,
        type: NotificationType.MEMBER_LEFT,
        title: 'Left Group',
        body: `You have left the group "${group.name}"`,
        metadata: {
          groupId,
          groupName: group.name,
        },
      });

      this.logger.log(
        `User ${userId} successfully left group ${groupId}`,
        'MembershipsService',
      );
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      // Log and re-throw unexpected errors
      this.logger.error(
        `Failed for user ${userId} to leave group ${groupId}: ${error.message}`,
        error.stack,
        'MembershipsService',
      );
      throw error;
    }
  }

  /**
   * Returns the membership scheduled to receive the payout for the current round.
   * Uses 0-indexed payoutOrder matching group.currentRound - 1.
   *
   * @param groupId - The UUID of the group
   * @returns The Membership entity for the current round's recipient
   * @throws NotFoundException if group doesn't exist or no member is scheduled
   * @throws BadRequestException if group is not ACTIVE
   */
  async getCurrentRecipient(groupId: string): Promise<Membership> {
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException(
        'Group must be ACTIVE to query current recipient',
      );
    }

    const expectedPayoutOrder = group.currentRound - 1;

    const membership = await this.membershipRepository.findOne({
      where: { groupId, payoutOrder: expectedPayoutOrder },
    });

    if (!membership) {
      throw new NotFoundException(
        `No member scheduled for payout in round ${group.currentRound}`,
      );
    }

    return membership;
  }

  /**
   * Records a payout to a member.
   * Validates group is ACTIVE, enforces sequential round-based payout order,
   * member exists and hasn't received payout yet.
   * Marks member as paid and stores transaction hash.
   *
   * @param groupId - The UUID of the group
   * @param recipientUserId - The UUID of the recipient user
   * @param transactionHash - The blockchain transaction hash
   * @returns The updated Membership entity
   * @throws NotFoundException if group or membership doesn't exist
   * @throws BadRequestException if group is not ACTIVE or payout order is wrong
   * @throws ConflictException if member already received payout
   */
  async recordPayout(
    groupId: string,
    recipientUserId: string,
    transactionHash: string,
  ): Promise<Membership> {
    this.logger.log(
      `Recording payout for user ${recipientUserId} in group ${groupId}`,
      'MembershipsService',
    );

    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException('Group must be ACTIVE to record payouts');
    }

    const membership = await this.membershipRepository.findOne({
      where: { groupId, userId: recipientUserId },
    });

    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    if (membership.hasReceivedPayout) {
      throw new ConflictException('Member has already received payout');
    }

    // Enforce sequential round-based payout: payoutOrder must match currentRound - 1 (0-indexed)
    const expectedPayoutOrder = group.currentRound - 1;
    if (membership.payoutOrder !== expectedPayoutOrder) {
      throw new BadRequestException(
        `Payout order mismatch: member has payoutOrder ${membership.payoutOrder} but current round ${group.currentRound} expects payoutOrder ${expectedPayoutOrder}`,
      );
    }

    membership.hasReceivedPayout = true;
    membership.transactionHash = transactionHash;

    const savedMembership = await this.membershipRepository.save(membership);

    await this.notificationsService.notify({
      userId: recipientUserId,
      type: NotificationType.PAYOUT_RECEIVED,
      title: 'Payout Received',
      body: `You have received your payout from group "${group.name}"`,
      metadata: {
        groupId,
        transactionHash,
        amount: group.contributionAmount,
      },
    });

    this.logger.log(
      `Payout recorded for user ${recipientUserId} in group ${groupId}`,
      'MembershipsService',
    );

    return savedMembership;
  }

  /**
   * Suspends a member from a group.
   * Only the group admin (identified by adminWallet) can suspend members.
   * An admin cannot suspend themselves.
   *
   * @param groupId - The UUID of the group
   * @param targetUserId - The UUID of the member to suspend
   * @param requestingUserId - The UUID of the requesting user (must be group admin)
   * @param reason - The reason for suspension
   * @returns The updated Membership entity
   */
  async suspendMember(
    groupId: string,
    targetUserId: string,
    requestingUserId: string,
    reason: string,
  ): Promise<Membership> {
    if (targetUserId === requestingUserId) {
      throw new ForbiddenException('Group admin cannot suspend themselves');
    }

    const group = await this.groupRepository.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');

    const requestingMembership = await this.membershipRepository.findOne({
      where: { groupId, userId: requestingUserId },
    });
    if (!requestingMembership) throw new ForbiddenException('Not a group member');
    if (group.adminWallet !== requestingMembership.walletAddress) {
      throw new ForbiddenException('Only the group admin can suspend members');
    }

    const targetMembership = await this.membershipRepository.findOne({
      where: { groupId, userId: targetUserId },
    });
    if (!targetMembership) throw new NotFoundException('Membership not found');

    if (targetMembership.status === MembershipStatus.SUSPENDED) {
      return targetMembership;
    }

    targetMembership.status = MembershipStatus.SUSPENDED;
    const saved = await this.membershipRepository.save(targetMembership);

    await this.notificationsService.notify({
      userId: targetUserId,
      type: NotificationType.MEMBER_SUSPENDED,
      title: 'Your membership has been suspended',
      body: `Your membership in group "${group.name}" has been suspended. Reason: ${reason}`,
      metadata: { groupId, reason, adminId: requestingUserId },
    });

    // A suspended member frees a slot — admit next from waitlist
    setImmediate(() =>
      this.waitlistService.admitNextFromWaitlist(groupId).catch((err) =>
        this.logger.error(
          `Failed to admit from waitlist after suspension in group ${groupId}: ${err.message}`,
          err.stack,
          'MembershipsService',
        ),
      ),
    );

    this.logger.log(
      `Member ${targetUserId} suspended in group ${groupId} by ${requestingUserId}`,
      'MembershipsService',
    );

    return saved;
  }

  /**
   * Reinstates a previously suspended member.
   * Only the group admin can reinstate members.
   *
   * @param groupId - The UUID of the group
   * @param targetUserId - The UUID of the member to reinstate
   * @param requestingUserId - The UUID of the requesting user (must be group admin)
   * @returns The updated Membership entity
   */
  async reinstateMember(
    groupId: string,
    targetUserId: string,
    requestingUserId: string,
  ): Promise<Membership> {
    const group = await this.groupRepository.findOne({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');

    const requestingMembership = await this.membershipRepository.findOne({
      where: { groupId, userId: requestingUserId },
    });
    if (!requestingMembership) throw new ForbiddenException('Not a group member');
    if (group.adminWallet !== requestingMembership.walletAddress) {
      throw new ForbiddenException('Only the group admin can reinstate members');
    }

    const targetMembership = await this.membershipRepository.findOne({
      where: { groupId, userId: targetUserId },
    });
    if (!targetMembership) throw new NotFoundException('Membership not found');

    targetMembership.status = MembershipStatus.ACTIVE;
    const saved = await this.membershipRepository.save(targetMembership);

    await this.notificationsService.notify({
      userId: targetUserId,
      type: NotificationType.MEMBER_REINSTATED,
      title: 'Your membership has been reinstated',
      body: `Your membership in group "${group.name}" has been reinstated.`,
      metadata: { groupId, adminId: requestingUserId },
    });

    this.logger.log(
      `Member ${targetUserId} reinstated in group ${groupId} by ${requestingUserId}`,
      'MembershipsService',
    );

    return saved;
  }
}
