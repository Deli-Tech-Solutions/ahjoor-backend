import {
  Controller,
  Post,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  ParseIntPipe,
  Request,
  Res,
  Version,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiSecurity,
  ApiHeader,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContributionsService } from './contributions.service';
import { ReceiptService } from './receipt.service';
import { CreateContributionDto } from './dto/create-contribution.dto';
import { ContributionResponseDto } from './dto/contribution-response.dto';
import { GetContributionsQueryDto } from './dto/get-contributions-query.dto';
import { ApiKeyGuard } from './guards/api-key.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { WalletThrottlerGuard } from '../throttler/guards/wallet-throttler.guard';
import { AuditLog } from '../audit/decorators/audit-log.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  IdempotencyInterceptor,
  RequiresIdempotency,
} from '../common/interceptors/idempotency.interceptor';

/**
 * Controller for managing ROSCA group contributions.
 * Provides REST API endpoints for creating and querying contribution records.
 */
@ApiTags('Contributions')
@Controller()
export class ContributionsController {
  constructor(
    private readonly contributionsService: ContributionsService,
    private readonly receiptService: ReceiptService,
  ) {}

  /**
   * Creates a new contribution record (internal endpoint).
   * Protected by API key authentication for system-to-system communication.
   * Rate limited to 10 requests per minute for payment security.
   *
   * @param createContributionDto - The contribution data
   * @returns The created contribution with HTTP 201 status
   * @throws BadRequestException if validation fails or foreign keys are invalid
   * @throws UnauthorizedException if API key is missing or invalid
   * @throws ConflictException if transaction hash already exists
   */
  @Post('internal/contributions')
  @UseGuards(ApiKeyGuard, JwtAuthGuard, WalletThrottlerGuard)
  @ApiSecurity('api_key')
  @ApiSecurity('JWT-auth')
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 requests per minute per wallet
  @HttpCode(HttpStatus.CREATED)
  @RequiresIdempotency()
  @ApiOperation({
    summary: 'Create contribution record (internal)',
    description:
      'Creates a new contribution record. Protected by API key. Rate limited to 10 requests per minute. Requires Idempotency-Key header (UUID v4).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID v4 for idempotent request handling',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiBody({ type: CreateContributionDto })
  @ApiResponse({
    status: 201,
    description: 'Contribution created successfully',
    type: ContributionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid input data, foreign key violation, or missing/invalid Idempotency-Key',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - API key required',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Transaction hash already exists',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests - rate limit exceeded',
    type: ErrorResponseDto,
  })
  @AuditLog({ action: 'CREATE', resource: 'CONTRIBUTION' })
  async createContribution(
    @Body() createContributionDto: CreateContributionDto,
    @Request() req: { headers: Record<string, string> },
  ): Promise<ContributionResponseDto> {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const contribution = await this.contributionsService.createContribution(
      createContributionDto,
      idempotencyKey,
    );

    // Transform entity to response DTO with ISO date strings
    return {
      id: contribution.id,
      groupId: contribution.groupId,
      userId: contribution.userId,
      walletAddress: contribution.walletAddress,
      roundNumber: contribution.roundNumber,
      amount: contribution.amount,
      transactionHash: contribution.transactionHash,
      timestamp: contribution.timestamp.toISOString(),
      createdAt: contribution.createdAt.toISOString(),
      updatedAt: contribution.updatedAt.toISOString(),
    };
  }

  /**
   * Retrieves all contributions for a specific group with pagination, sorting, and filtering.
   *
   * @param groupId - The UUID of the group
   * @param query - The pagination and filter query parameters
   * @returns Paginated envelope containing contributions for the group
   * @throws BadRequestException if groupId is not a valid UUID
   * @throws NotFoundException if the group doesn't exist
   */
  @Get('groups/:id/contributions')
  @ApiOperation({
    summary: 'Get group contributions',
    description:
      'Retrieves all contributions for a specific group with pagination, sorting, and filtering',
  })
  @ApiParam({ name: 'id', description: 'Group UUID', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Successfully retrieved contributions',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/ContributionResponseDto' },
        },
        total: { type: 'number', example: 100 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 20 },
        totalPages: { type: 'number', example: 5 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid UUID format',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Group not found',
    type: ErrorResponseDto,
  })
  async getGroupContributions(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Query() query: GetContributionsQueryDto,
  ): Promise<{
    data: ContributionResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const result = await this.contributionsService.getGroupContributions(
      groupId,
      query,
    );

    // Transform entities to response DTOs with ISO date strings
    return {
      ...result,
      data: result.data.map((contribution) => ({
        id: contribution.id,
        groupId: contribution.groupId,
        userId: contribution.userId,
        walletAddress: contribution.walletAddress,
        roundNumber: contribution.roundNumber,
        amount: contribution.amount,
        transactionHash: contribution.transactionHash,
        timestamp: contribution.timestamp.toISOString(),
        createdAt: contribution.createdAt.toISOString(),
        updatedAt: contribution.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Retrieves all contributions for a specific group and round.
   * This is a dedicated endpoint for round-specific queries.
   *
   * @param groupId - The UUID of the group
   * @param round - The round number
   * @returns Array of contributions for the group and round
   * @throws BadRequestException if groupId is not a valid UUID or round is invalid
   * @throws NotFoundException if the group doesn't exist
   */
  @Get('groups/:id/contributions/round/:round')
  async getRoundContributions(
    @Param('id', ParseUUIDPipe) groupId: string,
    @Param('round', ParseIntPipe) round: number,
  ): Promise<ContributionResponseDto[]> {
    const contributions = await this.contributionsService.getRoundContributions(
      groupId,
      round,
    );

    // Transform entities to response DTOs with ISO date strings
    return contributions.map((contribution) => ({
      id: contribution.id,
      groupId: contribution.groupId,
      userId: contribution.userId,
      walletAddress: contribution.walletAddress,
      roundNumber: contribution.roundNumber,
      amount: contribution.amount,
      transactionHash: contribution.transactionHash,
      timestamp: contribution.timestamp.toISOString(),
      createdAt: contribution.createdAt.toISOString(),
      updatedAt: contribution.updatedAt.toISOString(),
    }));
  }

  /**
   * Retrieves all contributions for the authenticated user across all groups.
   * Protected by JWT authentication.
   *
   * @param req - The request object containing authenticated user data
   * @returns Array of contributions for the authenticated user
   * @throws UnauthorizedException if JWT token is missing or invalid
   */
  @Get('users/me/contributions')
  @UseGuards(JwtAuthGuard)
  async getUserContributions(
    @Request() req: { user: { id: string; userId: string } },
  ): Promise<ContributionResponseDto[]> {
    // Extract userId from JWT token (attached by JwtAuthGuard)
    const userId = req.user.id || req.user.userId;

    const contributions =
      await this.contributionsService.getUserContributions(userId);

    // Transform entities to response DTOs with ISO date strings
    return contributions.map((contribution) => ({
      id: contribution.id,
      groupId: contribution.groupId,
      userId: contribution.userId,
      walletAddress: contribution.walletAddress,
      roundNumber: contribution.roundNumber,
      amount: contribution.amount,
      transactionHash: contribution.transactionHash,
      timestamp: contribution.timestamp.toISOString(),
      createdAt: contribution.createdAt.toISOString(),
      updatedAt: contribution.updatedAt.toISOString(),
    }));
  }

  @Get('contributions/:id/receipt')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Download PDF receipt for a contribution (owner or admin only)' })
  @ApiParam({ name: 'id', description: 'Contribution UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'PDF receipt streamed successfully' })
  @ApiResponse({ status: 403, description: 'Access denied', type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: 'Contribution not found', type: ErrorResponseDto })
  async downloadReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: { user: { id: string; userId: string } },
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user.id || req.user.userId;
    await this.receiptService.streamReceiptPdf(id, userId, res);
  }
}
