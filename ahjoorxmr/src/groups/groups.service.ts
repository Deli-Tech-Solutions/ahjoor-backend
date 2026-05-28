import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Group } from './entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { WinstonLogger } from '../common/logger/winston.logger';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { GroupStatus } from './entities/group-status.enum';
import { PayoutOrderStrategy } from './entities/payout-order-strategy.enum';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { StellarService } from '../stellar/stellar.service';
import { TransferAdminDto } from './dto/transfer-admin.dto';
import { MembershipStatus } from '../memberships/entities/membership-status.enum';
import { AuditService } from '../audit/audit.service';
import { WebhookService, WebhookEventType } from '../webhooks/webhook.service';
import { GroupActivatedPayload, GroupArchivedPayload } from '../webhooks/interfaces/webhook.interface';
import { GroupTemplatesService } from './group-templates.service';
import { GroupMaintenanceMixin } from '../common/services/group-maintenance.mixin';
import { MaintenanceModeService } from '../common/services/maintenance-mode.service';

import { UseReadReplica } from '../common/decorators/read-replica.decorator';

/**
 * Service responsible for managing ROSCA group operations.
 * Handles business logic for creating, reading, and updating groups.
 * Does NOT interact with smart contracts — that is handled by the Stellar service.
 */
@Injectable()
export class GroupsService {
  constructor(
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    private readonly logger: WinstonLogger,
    private readonly notificationsService: NotificationsService,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly groupTemplatesService: GroupTemplatesService,
    private readonly groupMaintenanceMixin: GroupMaintenanceMixin,
  ) {}

  /**
   * Creates a new ROSCA group with status PENDING.
   * The adminWallet is taken from the authenticated user's wallet (passed in, not from DTO).
   * If templateId is provided, template config is merged as defaults (explicit DTO fields override template values).
   *
   * @param createGroupDto - Group creation data
   * @param adminWallet - Wallet address of the authenticated admin user
   * @param userId - UUID of the authenticated user (needed for template visibility check)
   * @returns The created Group entity
   */
  async createGroup(
    createGroupDto: CreateGroupDto,
    adminWallet: string,
    userId?: string,
  ): Promise<Group> {
    this.logger.log(
      `Creating group "${createGroupDto.name}" for admin ${adminWallet}`,
      'GroupsService',
    );

    try {
      // Check global maintenance mode before creating a group
      const globalMaintenance = await this.maintenanceModeService.getGlobalMaintenanceMode();
      if (globalMaintenance?.enabled) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          message: globalMaintenance.message,
          retryAfter: globalMaintenance.retryAfterSeconds,
        });
      }

      let finalDto = { ...createGroupDto };

      // If templateId is provided, merge template config as defaults
      if (createGroupDto.templateId && userId) {
        const template = await this.groupTemplatesService.findTemplateById(
          createGroupDto.templateId,
          userId,
        );
        finalDto = this.groupTemplatesService.mergeTemplateConfig(template, finalDto);
      }

      const maxMembers =
        finalDto.maxMembers ?? finalDto.totalRounds;

      if (maxMembers !== finalDto.totalRounds) {
        throw new BadRequestException('maxMembers must equal totalRounds');
      }

      if (finalDto.minMembers > maxMembers) {
        throw new BadRequestException(
          'minMembers must be less than or equal to maxMembers',
        );
      }

      // Validate asset code against allow-list
      const assetCode = finalDto.assetCode ?? 'XLM';
      const allowedRaw = this.configService.get<string>('ALLOWED_ASSET_CODES', 'XLM,USDC');
      const allowedCodes = allowedRaw.split(',').map((c) => c.trim().toUpperCase());
      if (!allowedCodes.includes(assetCode.toUpperCase())) {
        throw new BadRequestException(
          `Asset code "${assetCode}" is not supported. Allowed: ${allowedCodes.join(', ')}`,
        );
      }

      const assetIssuer = assetCode.toUpperCase() === 'XLM' ? null : (finalDto.assetIssuer ?? null);

      const group = this.groupRepository.create({
        ...finalDto,
        maxMembers,
        adminWallet,
        status: GroupStatus.PENDING,
        currentRound: 0,
        contractAddress: finalDto.contractAddress ?? null,
        assetCode: assetCode.toUpperCase(),
        assetIssuer,
        payoutOrderStrategy: finalDto.payoutOrderStrategy
          ? (finalDto.payoutOrderStrategy as PayoutOrderStrategy)
          : PayoutOrderStrategy.SEQUENTIAL,
        penaltyRate: finalDto.penaltyRate ?? 0.05,
        gracePeriodHours: finalDto.gracePeriodHours ?? 24,
      });

      const savedGroup = await this.groupRepository.save(group);

      // Atomically increment template usage count if template was used
      if (createGroupDto.templateId) {
        await this.groupTemplatesService.incrementUsageCount(
          createGroupDto.templateId,
        );
      }

      this.logger.log(
        `Group created with id ${savedGroup.id} for admin ${adminWallet}`,
        'GroupsService',
      );

      return savedGroup;
    } catch (error) {
      this.logger.error(
        `Failed to create group for admin ${adminWallet}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Returns a paginated list of all ROSCA groups ordered by creation date (newest first).
   * Soft-deleted groups are excluded by default unless includeArchived is true.
   *
   * @param page - Page number (1-indexed)
   * @param limit - Number of items per page
   * @param includeArchived - Whether to include soft-deleted groups
   * @param filter - Optional filter: 'stale' to return only stale groups
   * @returns Paginated result with data, total count, page, and limit
   */
  @UseReadReplica()
  async findAll(
    page: number = 1,
    limit: number = 10,
    includeArchived: boolean = false,
    filter?: string,
  ): Promise<{ data: Group[]; total: number; page: number; limit: number }> {
    this.logger.log(
      `Fetching groups page=${page} limit=${limit} includeArchived=${includeArchived} filter=${filter}`,
      'GroupsService',
    );

    try {
      const skip = (page - 1) * limit;

      const qb = this.groupRepository
        .createQueryBuilder('group')
        .orderBy('group.createdAt', 'DESC')
        .skip(skip)
        .take(limit);

      if (includeArchived) {
        qb.withDeleted();
      }

      // Apply stale filter if requested
      if (filter === 'stale') {
        qb.andWhere('group.staleAt IS NOT NULL');
      }

      const [data, total] = await qb.getManyAndCount();

      this.logger.log(
        `Found ${total} group(s); returning page ${page}`,
        'GroupsService',
      );

      return { data, total, page, limit };
    } catch (error) {
      this.logger.error(
        `Failed to fetch groups: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Returns full group details including its members.
   *
   * @param id - The UUID of the group
   * @returns The Group entity with populated memberships
   * @throws NotFoundException if the group doesn't exist
   */
  async findOne(id: string): Promise<Group> {
    this.logger.log(`Fetching group ${id}`, 'GroupsService');

    try {
      const group = await this.groupRepository.findOne({
        where: { id },
        relations: ['memberships'],
      });

      if (!group) {
        this.logger.warn(`Group ${id} not found`, 'GroupsService');
        throw new NotFoundException(`Group with id ${id} not found`);
      }

      return group;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Failed to fetch group ${id}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Updates group metadata. Only allowed when the group is in PENDING status.
   * Throws BadRequestException if the group is ACTIVE or COMPLETED.
   *
   * @param id - The UUID of the group
   * @param updateGroupDto - Fields to update
   * @param requestingAdminWallet - Wallet address of the requesting user (must be group admin)
   * @returns The updated Group entity
   * @throws NotFoundException if the group doesn't exist
   * @throws BadRequestException if the group is not PENDING
   * @throws ForbiddenException if the requester is not the group admin
   */
  async update(
    id: string,
    updateGroupDto: UpdateGroupDto,
    requestingAdminWallet: string,
  ): Promise<Group> {
    this.logger.log(
      `Updating group ${id} by admin ${requestingAdminWallet}`,
      'GroupsService',
    );

    try {
      const group = await this.groupRepository.findOne({ where: { id } });

      if (!group) {
        this.logger.warn(`Group ${id} not found for update`, 'GroupsService');
        throw new NotFoundException(`Group with id ${id} not found`);
      }

      if (group.adminWallet !== requestingAdminWallet) {
        this.logger.warn(
          `Admin wallet mismatch: ${requestingAdminWallet} is not the admin of group ${id}`,
          'GroupsService',
        );
        throw new ForbiddenException(
          'Only the group admin can update this group',
        );
      }

      if (group.status !== GroupStatus.PENDING) {
        this.logger.warn(
          `Cannot update group ${id} with status ${group.status}`,
          'GroupsService',
        );
        throw new BadRequestException(
          `Cannot update group metadata after it becomes ${group.status}. Only PENDING groups can be updated.`,
        );
      }

      Object.assign(group, updateGroupDto);
      const savedGroup = await this.groupRepository.save(group);

      this.logger.log(`Group ${id} updated successfully`, 'GroupsService');

      return savedGroup;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(
        `Failed to update group ${id}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Returns all groups that the authenticated user (by userId) belongs to as a member.
   * Excludes soft-deleted groups.
   *
   * @param userId - The UUID of the authenticated user
   * @returns Array of Group entities the user is a member of
   */
  async findMyGroups(userId: string): Promise<Group[]> {
    this.logger.log(`Fetching groups for user ${userId}`, 'GroupsService');

    try {
      const memberships = await this.membershipRepository.find({
        where: { userId },
        relations: ['group'],
      });

      const groups = memberships
        .map((m) => m.group)
        .filter((g) => g && !g.deletedAt);

      this.logger.log(
        `Found ${groups.length} group(s) for user ${userId}`,
        'GroupsService',
      );

      return groups;
    } catch (error) {
      this.logger.error(
        `Failed to fetch groups for user ${userId}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Soft-deletes a group by setting deletedAt timestamp.
   * Only the group admin can delete the group.
   *
   * @param id - The UUID of the group
   * @param adminWallet - Wallet address of the requesting admin
   * @throws NotFoundException if the group doesn't exist
   * @throws ForbiddenException if the requester is not the group admin
   */
  async softDelete(id: string, adminWallet: string): Promise<void> {
    this.logger.log(
      `Soft-deleting group ${id} by admin ${adminWallet}`,
      'GroupsService',
    );

    const group = await this.groupRepository.findOne({ where: { id } });

    if (!group) {
      this.logger.warn(`Group ${id} not found for deletion`, 'GroupsService');
      throw new NotFoundException(`Group with id ${id} not found`);
    }

    if (group.adminWallet !== adminWallet) {
      this.logger.warn(
        `Admin wallet mismatch: ${adminWallet} is not the admin of group ${id}`,
        'GroupsService',
      );
      throw new ForbiddenException(
        'Only the group admin can delete this group',
      );
    }

    await this.groupRepository.softDelete(id);

    this.logger.log(`Group ${id} soft-deleted successfully`, 'GroupsService');

    // Dispatch GROUP_ARCHIVED webhook event
    try {
      const payload: GroupArchivedPayload = {
        groupId: id,
        archivedAt: new Date().toISOString(),
      };
      await this.webhookService.dispatchEvent(WebhookEventType.GROUP_ARCHIVED, payload);
      this.logger.log(`Dispatched GROUP_ARCHIVED webhook for group ${id}`, 'GroupsService');
    } catch (webhookError) {
      this.logger.error(
        `Failed to dispatch GROUP_ARCHIVED webhook for group ${id}: ${(webhookError as Error).message}`,
        (webhookError as Error).stack,
        'GroupsService',
      );
    }
  }

  /**
   * Activates a PENDING group if all conditions are met.
   * Only the group admin can activate the group.
   * The group must have enough members to meet the minimum requirement.
   *
   * @param groupId - The UUID of the group to activate
   * @param adminWallet - Wallet address of the requesting admin
   * @returns The updated Group entity with status ACTIVE
   * @throws NotFoundException if the group doesn't exist
   * @throws ForbiddenException if the requester is not the group admin
   * @throws BadRequestException if the group is not PENDING or doesn't have enough members
   */
  async activateGroup(groupId: string, adminWallet: string): Promise<Group> {
    this.logger.log(
      `Activating group ${groupId} by admin ${adminWallet}`,
      'GroupsService',
    );

    try {
      // 1. Fetch group by ID
      const group = await this.groupRepository.findOne({
        where: { id: groupId },
        relations: ['memberships'],
      });

      if (!group) {
        this.logger.warn(`Group ${groupId} not found`, 'GroupsService');
        throw new NotFoundException('Group not found');
      }

      // 2. Check adminWallet === group.adminWallet
      if (group.adminWallet !== adminWallet) {
        this.logger.warn(
          `Admin wallet mismatch: ${adminWallet} is not the admin of group ${groupId}`,
          'GroupsService',
        );
        throw new ForbiddenException(
          'Only the group admin can activate this group',
        );
      }

      // 3. Check group.status === PENDING
      if (group.status !== GroupStatus.PENDING) {
        this.logger.warn(
          `Cannot activate group ${groupId} with status ${group.status}`,
          'GroupsService',
        );
        throw new BadRequestException('Group is not in a pending state');
      }

      // 4. Check group.members.length >= group.minMembers
      const members = group.memberships || [];
      const memberCount = members.length;
      if (memberCount < group.minMembers) {
        this.logger.warn(
          `Group ${groupId} has ${memberCount} members but requires ${group.minMembers}`,
          'GroupsService',
        );
        throw new BadRequestException('Group does not have enough members');
      }

      // Handle Payout Order Strategy
      if (group.payoutOrderStrategy === PayoutOrderStrategy.RANDOM) {
        const indices = Array.from({ length: memberCount }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        for (let i = 0; i < members.length; i++) {
          members[i].payoutOrder = indices[i];
          await this.membershipRepository.save(members[i]);
        }
      } else if (
        group.payoutOrderStrategy === PayoutOrderStrategy.ADMIN_DEFINED
      ) {
        const orders = members.map((m) => m.payoutOrder);
        if (orders.some((o) => o === null || o === undefined)) {
          throw new BadRequestException(
            'All members must have a payout order for ADMIN_DEFINED strategy',
          );
        }
        const sortedOrders = [...orders].sort((a, b) => a! - b!);
        for (let i = 0; i < memberCount; i++) {
          if (sortedOrders[i] !== i) {
            throw new BadRequestException(
              'Payout orders must be a continuous sequence starting from 0',
            );
          }
        }
      }

      // 5. Set group.status = ACTIVE
      group.status = GroupStatus.ACTIVE;

      // 6. Set group.currentRound = 1
      group.currentRound = 1;

      // 7. If RoundsService exists, initialize the first round
      // (RoundsService does not exist in this codebase, so we skip this step)

      // 8. Persist and return the updated group
      const savedGroup = await this.groupRepository.save(group);

      try {
        const contractAddress =
          await this.stellarService.deployRoscaContract(savedGroup);
        savedGroup.contractAddress = contractAddress;
        await this.groupRepository.save(savedGroup);
        this.logger.log(
          `Group ${groupId} activated and contract deployed at ${contractAddress}`,
          'GroupsService',
        );

        // Dispatch GROUP_ACTIVATED webhook event
        try {
          const members = group.memberships || [];
          const payload: GroupActivatedPayload = {
            groupId,
            activatedAt: new Date().toISOString(),
            totalRounds: group.totalRounds,
            memberCount: members.length,
          };
          await this.webhookService.dispatchEvent(WebhookEventType.GROUP_ACTIVATED, payload);
          this.logger.log(`Dispatched GROUP_ACTIVATED webhook for group ${groupId}`, 'GroupsService');
        } catch (webhookError) {
          this.logger.error(
            `Failed to dispatch GROUP_ACTIVATED webhook for group ${groupId}: ${(webhookError as Error).message}`,
            (webhookError as Error).stack,
            'GroupsService',
          );
        }
      } catch (deployError) {
        savedGroup.status = GroupStatus.PENDING;
        savedGroup.currentRound = 0;
        await this.groupRepository.save(savedGroup);
        this.logger.error(
          `Contract deployment failed for group ${groupId}: ${
            (deployError as Error).message
          }`,
          (deployError as Error).stack,
          'GroupsService',
        );
        throw new BadRequestException(
          'Failed to deploy on-chain contract; activation rolled back',
        );
      }

      return savedGroup;
    } catch (error: any) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      this.logger.error(
        `Failed to activate group ${groupId}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }

  /**
   * Transfers group admin ownership to another active member.
   *
   * @param groupId - The UUID of the group
   * @param adminWallet - Wallet address of the current admin
   * @param transferAdminDto - Data containing the new admin user ID
   * @returns The updated Group entity
   */
  async transferAdmin(
    groupId: string,
    adminWallet: string,
    transferAdminDto: TransferAdminDto,
  ): Promise<Group> {
    const { newAdminUserId } = transferAdminDto;

    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.adminWallet !== adminWallet) {
      throw new ForbiddenException('Only the current admin can transfer ownership');
    }

    // Verify the target user has an ACTIVE membership in the group
    const newAdminMembership = await this.membershipRepository.findOne({
      where: {
        groupId,
        userId: newAdminUserId,
        status: MembershipStatus.ACTIVE,
      },
    });

    if (!newAdminMembership) {
      throw new BadRequestException(
        'Target user must be an active member of the group',
      );
    }

    const oldAdminWallet = group.adminWallet;
    const newAdminWallet = newAdminMembership.walletAddress;

    // Update atomically
    group.adminWallet = newAdminWallet;
    const savedGroup = await this.groupRepository.save(group);

    // Emit audit log
    await this.auditService.createLog({
      userId: group.id, // Or use the requester's ID if available
      action: 'GROUP_ADMIN_TRANSFER',
      resource: 'Group',
      metadata: {
        groupId,
        oldAdminWallet,
        newAdminWallet,
        newAdminUserId,
      },
    });

    // Send notifications to both old and new admin
    const notifications = [
      {
        userId: newAdminUserId,
        type: NotificationType.ADMIN_TRANSFERRED,
        title: 'Group Admin Ownership Transferred',
        body: `You are now the admin of group "${group.name}"`,
        metadata: { groupId, role: 'new_admin' },
      },
      // Note: We need to find the user ID for the old admin to notify them
      // Assuming we can find it via membership or by adding it to the group entity if needed.
      // For now, let's notify the new admin. If we need to notify the old admin, we should find their userId.
    ];

    // Attempt to notify old admin if they are still a member
    const oldAdminMembership = await this.membershipRepository.findOne({
      where: { groupId, walletAddress: oldAdminWallet },
    });

    if (oldAdminMembership) {
      notifications.push({
        userId: oldAdminMembership.userId,
        type: NotificationType.ADMIN_TRANSFERRED,
        title: 'Group Admin Ownership Transferred',
        body: `You have transferred admin ownership of group "${group.name}" to another member`,
        metadata: { groupId, role: 'old_admin' },
      });
    }

    await this.notificationsService.notifyBatch(notifications);

    this.logger.log(
      `Admin ownership of group ${groupId} transferred from ${oldAdminWallet} to ${newAdminWallet}`,
      'GroupsService',
    );

    return savedGroup;
  }

  /**
   * Advances the group to the next round.
   * Only the group admin can advance a round.
   * All members must have paid their current round contribution.
   *
   * Before incrementing currentRound, the on-chain payout is sent to the
   * recipient for the completing round (the member whose payoutOrder equals
   * currentRound - 1). The round only advances if the on-chain call succeeds.
   * The transaction hash is stored on the recipient's Membership record.
   * Everything is wrapped in a DB transaction so the DB stays in sync with
   * the chain.
   *
   * If currentRound exceeds totalRounds, the group is marked as COMPLETED.
   *
   * @param groupId - The UUID of the group
   * @param adminWallet - Wallet address of the requesting admin
   * @returns The updated Group entity
   * @throws NotFoundException if the group doesn't exist
   * @throws ForbiddenException if the requester is not the group admin
   * @throws BadRequestException if the group is not ACTIVE or members haven't paid
   * @throws InternalServerErrorException if the on-chain payout fails
   */
  async advanceRound(groupId: string, adminWallet: string): Promise<Group> {
    this.logger.log(
      `Advancing round for group ${groupId} by admin ${adminWallet}`,
      'GroupsService',
    );

    // Load group outside the transaction for validation (read-only checks)
    const group = await this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['memberships'],
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.adminWallet !== adminWallet) {
      throw new ForbiddenException('Only the group admin can advance rounds');
    }

    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException('Group must be ACTIVE to advance rounds');
    }

    const unpaidMembers =
      group.memberships?.filter((m) => !m.hasPaidCurrentRound) || [];

    if (unpaidMembers.length > 0) {
      throw new BadRequestException(
        'All members must pay before advancing to the next round',
      );
    }

    // Determine the recipient for the completing round.
    // payoutOrder is 0-indexed; currentRound is 1-indexed, so the recipient
    // for round N has payoutOrder === N - 1.
    const completingRoundIndex = group.currentRound - 1;
    const recipient = (group.memberships || []).find(
      (m) => m.payoutOrder === completingRoundIndex,
    );

    // Emit the on-chain payout BEFORE touching the DB round counter.
    // If this throws, the DB transaction never commits.
    let txHash: string | null = null;
    if (recipient && group.contractAddress) {
      this.logger.log(
        `Disbursing payout to ${recipient.walletAddress} for round ${group.currentRound} of group ${groupId}`,
        'GroupsService',
      );
      try {
        txHash = await this.stellarService.disbursePayout(
          group.contractAddress,
          recipient.walletAddress,
          group.contributionAmount,
        );
        this.logger.log(
          `On-chain payout successful, txHash=${txHash}`,
          'GroupsService',
        );
      } catch (payoutError) {
        this.logger.error(
          `On-chain payout failed for group ${groupId}: ${(payoutError as Error).message}`,
          (payoutError as Error).stack,
          'GroupsService',
        );
        throw new InternalServerErrorException(
          'On-chain payout failed; round not advanced',
        );
      }
    }

    // Wrap all DB mutations in a transaction so the round only advances when
    // everything (including the txHash write) succeeds atomically.
    const savedGroup = await this.dataSource.transaction(async (manager) => {
      const groupRepo = manager.getRepository(Group);
      const membershipRepo = manager.getRepository(Membership);

      // Re-fetch inside the transaction to get a fresh lock
      const lockedGroup = await groupRepo.findOne({
        where: { id: groupId },
        relations: ['memberships'],
      });

      if (!lockedGroup) {
        throw new NotFoundException('Group not found');
      }

      // Store the transaction hash on the recipient's membership
      if (recipient && txHash) {
        const recipientMembership = lockedGroup.memberships?.find(
          (m) => m.id === recipient.id,
        );
        if (recipientMembership) {
          recipientMembership.transactionHash = txHash;
          await membershipRepo.save(recipientMembership);
        }
      }

      lockedGroup.currentRound += 1;

      // Clear stale flag when group is updated
      if (lockedGroup.staleAt) {
        lockedGroup.staleAt = null;
        this.logger.log(
          `Cleared stale flag for group ${groupId} during round advance`,
          'GroupsService',
        );
      }

      if (lockedGroup.currentRound > lockedGroup.totalRounds) {
        lockedGroup.status = GroupStatus.COMPLETED;
        this.logger.log(
          `Group ${groupId} marked as COMPLETED`,
          'GroupsService',
        );
      } else {
        // Reset payment flags for new round
        for (const membership of lockedGroup.memberships || []) {
          membership.hasPaidCurrentRound = false;
          await membershipRepo.save(membership);
        }
      }

      return groupRepo.save(lockedGroup);
    });

    // Send notifications outside the DB transaction (non-critical)
    if (savedGroup.status !== GroupStatus.COMPLETED) {
      const notificationDtos = (group.memberships || []).map((membership) => ({
        userId: membership.userId,
        type: NotificationType.ROUND_OPENED,
        title: 'New Round Started',
        body: `Round ${savedGroup.currentRound} has started for group "${group.name}"`,
        metadata: {
          groupId: group.id,
          round: savedGroup.currentRound,
        },
        idempotencyKey: `${group.id}-${savedGroup.currentRound}-${membership.userId}-ROUND_OPENED`,
      }));

      await this.notificationsService.notifyBatch(notificationDtos);
    }

    this.logger.log(
      `Group ${groupId} advanced to round ${savedGroup.currentRound}`,
      'GroupsService',
    );

    return savedGroup;
  }

  /**
   * Retrieves the on-chain contract state for a specific group.
   * Calls the Stellar service to fetch the current state from the smart contract.
   *
   * @param groupId - The UUID of the group
   * @returns The on-chain contract state
   * @throws NotFoundException if the group doesn't exist
   * @throws BadRequestException if the group has no contract address
   */
  async getContractState(groupId: string): Promise<unknown> {
    this.logger.log(
      `Fetching contract state for group ${groupId}`,
      'GroupsService',
    );

    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (!group.contractAddress) {
      throw new BadRequestException(
        'Group has no contract address. Contract may not be deployed yet.',
      );
    }

    try {
      const state = await this.stellarService.getGroupState(
        group.contractAddress,
      );
      this.logger.log(
        `Successfully fetched contract state for group ${groupId}`,
        'GroupsService',
      );
      return state;
    } catch (error) {
      this.logger.error(
        `Failed to fetch contract state for group ${groupId}: ${error.message}`,
        error.stack,
        'GroupsService',
      );
      throw error;
    }
  }
}
