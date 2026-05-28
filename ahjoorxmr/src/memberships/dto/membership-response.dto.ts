import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus } from '../entities/membership-status.enum';

/**
 * Response DTO for membership data.
 * Returns all membership fields with dates in ISO 8601 format.
 */
export class MembershipResponseDto {
  @ApiProperty({
    description: 'Membership unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Group unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  groupId: string;

  @ApiProperty({
    description: 'User unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  userId: string;

  @ApiProperty({
    description: 'Stellar wallet address of the member',
    example: 'GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON',
  })
  walletAddress: string;

  @ApiProperty({
    description: 'Order in which member receives payout (1-based)',
    example: 1,
    minimum: 1,
  })
  payoutOrder: number;

  @ApiProperty({
    description: 'Whether the member has received their payout',
    example: false,
  })
  hasReceivedPayout: boolean;

  @ApiProperty({
    description: 'Whether the member has paid for the current round',
    example: true,
  })
  hasPaidCurrentRound: boolean;

  @ApiProperty({
    description: 'Membership status',
    enum: MembershipStatus,
    example: MembershipStatus.ACTIVE,
  })
  transactionHash?: string | null;
  status: MembershipStatus;

  @ApiPropertyOptional({
    description:
      'Cross-group trust score in the range [0, 100]. Null until the first nightly calculation has run.',
    example: 72.5,
    nullable: true,
    minimum: 0,
    maximum: 100,
  })
  trustScore?: number | null;

  @ApiProperty({
    description: 'Membership creation timestamp (ISO 8601)',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt: string;

  @ApiProperty({
    description: 'Last update timestamp (ISO 8601)',
    example: '2024-01-01T00:00:00.000Z',
  })
  updatedAt: string;
}

/**
 * Paginated response DTO for membership list endpoints.
 */
export class PaginatedMembershipsResponseDto {
  @ApiProperty({ type: [MembershipResponseDto] })
  data: MembershipResponseDto[];

  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;
}

