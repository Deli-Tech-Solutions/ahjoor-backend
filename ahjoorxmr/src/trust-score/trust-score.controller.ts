import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  Request,
  Version,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TrustScoreService } from './trust-score.service';
import { TrustScoreResponseDto } from './dto/trust-score-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';

@ApiTags('Trust Scores')
@Controller('users')
@Version('1')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TrustScoreController {
  constructor(private readonly trustScoreService: TrustScoreService) {}

  /**
   * GET /api/v1/users/:id/trust-score
   *
   * Returns the cross-group trust score and component breakdown for a user.
   *
   * Access control:
   *  - The requesting user may always view their own score.
   *  - A platform admin (role === 'admin') may view any score.
   *  - A group admin of any group the target user belongs to may view the score.
   *  - All other callers receive 403.
   */
  @Get(':id/trust-score')
  @ApiOperation({
    summary: 'Get cross-group trust score for a user',
    description:
      'Returns the aggregated trust score and component breakdown. ' +
      'Accessible by the user themselves or any group admin.',
  })
  @ApiParam({ name: 'id', description: 'Target user UUID', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description: 'Trust score retrieved successfully',
    type: TrustScoreResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden – caller is neither the user nor a group admin',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'User not found',
    type: ErrorResponseDto,
  })
  async getTrustScore(
    @Param('id', ParseUUIDPipe) targetUserId: string,
    @Request() req: { user: { id: string; userId?: string; role: string } },
  ): Promise<TrustScoreResponseDto> {
    // Support both `id` and `userId` depending on JWT strategy shape
    const callerId = req.user.id ?? req.user.userId;
    const callerRole = req.user.role ?? 'user';

    const isGroupAdmin = await this.trustScoreService.isCallerGroupAdminOfUser(
      callerId,
      targetUserId,
    );

    return this.trustScoreService.getTrustScore(
      targetUserId,
      callerId,
      callerRole,
      isGroupAdmin,
    );
  }
}
