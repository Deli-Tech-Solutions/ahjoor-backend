import {
  Controller,
  Post,
  Delete,
  Get,
  Patch,
  HttpCode,
  HttpStatus,
  Param,
  Body,
  ParseUUIDPipe,
  UseGuards,
  Request,
  Version,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { MembershipsService } from './memberships.service';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdatePayoutOrderDto } from './dto/update-payout-order.dto';
import { MembershipResponseDto, PaginatedMembershipsResponseDto } from './dto/membership-response.dto';
import { RecordPayoutDto } from './dto/record-payout.dto';
import { JwtAuthGuard } from '../groups/guards/jwt-auth.guard';
import { WalletThrottlerGuard } from '../throttler/guards/wallet-throttler.guard';
import { AuditLog } from '../audit/decorators/audit-log.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PaginationQueryDto } from '../groups/dto/pagination-query.dto';
import { Throttle } from '@nestjs/throttler';

/**
 * Controller for managing ROSCA group memberships.
 * Provides REST API endpoints for adding, removing, and listing group members.
 */
@ApiTags('Memberships')
@Controller('groups')
@Version('1')
@UseInterceptors(IdempotencyInterceptor)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  /**
   * Adds a new member to a ROSCA group.
   * Only allowed before the group becomes active.
   *
   * @param groupId - The UUID of the group (validated by ParseUUIDPipe)
   * @param createMembershipDto - The membership data (userId and walletAddress)
   * @returns The created membership with HTTP 201 status
   * @throws BadRequestException if the group is active or doesn't exist
   * @throws ConflictException if the user is already a member
   */
  @Post(':id/members')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add member to group',
    description:
      'Adds a new member to a ROSCA group. Only allowed before the group becomes active.',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiBody({ type: CreateMembershipDto })
  @ApiResponse({
    status: 201,
    description: 'Member added successfully',
    type: MembershipResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input data or group is already active',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group not found',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'User is already a member of this group',
    type: ErrorResponseDto,
  })
  @AuditLog({ action: 'CREATE', resource: 'MEMBERSHIP' })
  async addMember(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() createMembershipDto: CreateMembershipDto,
  ): Promise<MembershipResponseDto> {
    const membership = await this.membershipsService.addMember(
      groupId,
      createMembershipDto,
    );

    return {
      id: membership.id,
      groupId: membership.groupId,
      userId: membership.userId,
      walletAddress: membership.walletAddress,
      payoutOrder: membership.payoutOrder,
      hasReceivedPayout: membership.hasReceivedPayout,
      hasPaidCurrentRound: membership.hasPaidCurrentRound,
      transactionHash: membership.transactionHash,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    };
  }

  /**
   * Removes a member from a ROSCA group.
   * Only allowed before the group becomes active.
   *
   * @param groupId - The UUID of the group (validated by ParseUUIDPipe)
   * @param userId - The UUID of the user to remove (validated by ParseUUIDPipe)
   * @returns No content with HTTP 204 status
   * @throws BadRequestException if the group is active or doesn't exist
   * @throws NotFoundException if the membership doesn't exist
   */
  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove member from group',
    description:
      'Removes a member from a ROSCA group. Only allowed before the group becomes active.',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'User UUID', format: 'uuid' })
  @ApiResponse({
    status: 204,
    description: 'Member removed successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Group is already active',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group or membership not found',
    type: ErrorResponseDto,
  })
  @AuditLog({ action: 'DELETE', resource: 'MEMBERSHIP' })
  async removeMember(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.membershipsService.removeMember(groupId, userId);
  }

  /**
   * Lists members of a ROSCA group with pagination.
   * Returns members ordered by payout order.
   *
   * @param groupId - The UUID of the group (validated by ParseUUIDPipe)
   * @param query - Pagination params (page, limit)
   * @returns Paginated memberships with HTTP 200 status
   */
  @Get(':id/members')
  @ApiOperation({
    summary: 'List group members',
    description: 'Lists members of a ROSCA group with pagination, ordered by payout order',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)', example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Successfully retrieved group members',
    type: PaginatedMembershipsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid pagination params',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group not found',
    type: ErrorResponseDto,
  })
  async listMembers(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedMembershipsResponseDto> {
    const { page = 1, limit = 20 } = query;
    const result = await this.membershipsService.listMembers(groupId, page, limit);

    return {
      data: result.data.map((membership) => ({
        id: membership.id,
        groupId: membership.groupId,
        userId: membership.userId,
        walletAddress: membership.walletAddress,
        payoutOrder: membership.payoutOrder,
        hasReceivedPayout: membership.hasReceivedPayout,
        hasPaidCurrentRound: membership.hasPaidCurrentRound,
        transactionHash: membership.transactionHash,
        status: membership.status,
        trustScore: membership.trustScore ?? null,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /**
   * Allows a member to leave a PENDING group (self-service).
   * Members can only leave before the group becomes active.
   *
   * @param groupId - The UUID of the group
   * @param req - The authenticated request containing user information
   * @returns No content with HTTP 204 status
   * @throws BadRequestException if the group is ACTIVE or COMPLETED
   * @throws NotFoundException if the membership doesn't exist
   */
  @Delete(':id/members/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Leave group (self-service)',
    description:
      'Allows a member to leave a PENDING group. Only allowed before the group becomes active.',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiResponse({
    status: 204,
    description: 'Successfully left the group',
  })
  @ApiResponse({
    status: 400,
    description: 'Group is ACTIVE or COMPLETED, cannot leave',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group or membership not found',
    type: ErrorResponseDto,
  })
  @AuditLog({ action: 'DELETE', resource: 'MEMBERSHIP' })
  async leaveGroup(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Request() req: any,
  ): Promise<void> {
    const userId = req.user.userId;
    await this.membershipsService.leaveGroup(groupId, userId);
  }

  /**
   * Returns the membership scheduled to receive the payout for the current round.
   *
   * @param groupId - The UUID of the group
   * @returns The membership for the current round's recipient
   * @throws NotFoundException if group doesn't exist or no member is scheduled
   * @throws BadRequestException if group is not ACTIVE
   */
  @Get(':id/current-recipient')
  @ApiOperation({
    summary: 'Get current round payout recipient',
    description:
      'Returns the membership scheduled to receive the payout for the current round',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Successfully retrieved current recipient',
    type: MembershipResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Group is not ACTIVE',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group not found or no member scheduled for current round',
    type: ErrorResponseDto,
  })
  async getCurrentRecipient(
    @Param('id', ParseUUIDPipe) groupId: string,
  ): Promise<MembershipResponseDto> {
    const membership =
      await this.membershipsService.getCurrentRecipient(groupId);

    return {
      id: membership.id,
      groupId: membership.groupId,
      userId: membership.userId,
      walletAddress: membership.walletAddress,
      payoutOrder: membership.payoutOrder,
      hasReceivedPayout: membership.hasReceivedPayout,
      hasPaidCurrentRound: membership.hasPaidCurrentRound,
      transactionHash: membership.transactionHash,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    };
  }

  /**
   * Records a payout to a member.
   * Admin-only endpoint that marks a member as having received their payout.
   * Rate limited to 5 requests per minute per authenticated user.
   *
   * @param groupId - The UUID of the group
   * @param recordPayoutDto - Payout details (recipientUserId and transactionHash)
   * @returns The updated membership with HTTP 200 status
   * @throws NotFoundException if group or membership doesn't exist
   * @throws BadRequestException if group is not ACTIVE or Idempotency-Key is missing/invalid
   * @throws ConflictException if member already received payout
   */
  @Post(':id/payout')
  @UseGuards(JwtAuthGuard, WalletThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record payout to member' })
  @ApiResponse({ status: 200, description: 'Payout recorded', type: MembershipResponseDto })
  @ApiResponse({ status: 429, description: 'Too many requests – rate limit exceeded', type: ErrorResponseDto })
  async recordPayout(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Body() recordPayoutDto: RecordPayoutDto,
  ): Promise<MembershipResponseDto> {
    const membership = await this.membershipsService.recordPayout(
      groupId,
      recordPayoutDto.recipientUserId,
      recordPayoutDto.transactionHash,
    );

    return {
      id: membership.id,
      groupId: membership.groupId,
      userId: membership.userId,
      walletAddress: membership.walletAddress,
      payoutOrder: membership.payoutOrder,
      hasReceivedPayout: membership.hasReceivedPayout,
      hasPaidCurrentRound: membership.hasPaidCurrentRound,
      transactionHash: membership.transactionHash,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    };
  }

  @Patch(':id/members/:userId/suspend')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a group member (group admin only)' })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'Target user UUID', format: 'uuid' })
  @ApiBody({ schema: { properties: { reason: { type: 'string' } }, required: ['reason'] } })
  @ApiResponse({ status: 200, description: 'Member suspended', type: MembershipResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden', type: ErrorResponseDto })
  @AuditLog({ action: 'SUSPEND', resource: 'MEMBERSHIP' })
  async suspendMember(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body('reason') reason: string,
    @Request() req: any,
  ): Promise<MembershipResponseDto> {
    const membership = await this.membershipsService.suspendMember(
      groupId,
      userId,
      req.user.userId,
      reason,
    );
    return {
      id: membership.id,
      groupId: membership.groupId,
      userId: membership.userId,
      walletAddress: membership.walletAddress,
      payoutOrder: membership.payoutOrder,
      hasReceivedPayout: membership.hasReceivedPayout,
      hasPaidCurrentRound: membership.hasPaidCurrentRound,
      transactionHash: membership.transactionHash,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    };
  }

  @Patch(':id/members/:userId/reinstate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reinstate a suspended group member (group admin only)' })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiParam({ name: 'userId', description: 'Target user UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Member reinstated', type: MembershipResponseDto })
  @ApiResponse({ status: 403, description: 'Forbidden', type: ErrorResponseDto })
  @AuditLog({ action: 'REINSTATE', resource: 'MEMBERSHIP' })
  async reinstateMember(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any,
  ): Promise<MembershipResponseDto> {
    const membership = await this.membershipsService.reinstateMember(
      groupId,
      userId,
      req.user.userId,
    );
    return {
      id: membership.id,
      groupId: membership.groupId,
      userId: membership.userId,
      walletAddress: membership.walletAddress,
      payoutOrder: membership.payoutOrder,
      hasReceivedPayout: membership.hasReceivedPayout,
      hasPaidCurrentRound: membership.hasPaidCurrentRound,
      transactionHash: membership.transactionHash,
      status: membership.status,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    };
  }
}
