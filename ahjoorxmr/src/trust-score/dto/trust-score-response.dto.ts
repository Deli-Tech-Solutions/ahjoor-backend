import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO for the GET /users/:id/trust-score endpoint.
 * Returns the aggregated trust score and its component breakdown.
 */
export class TrustScoreResponseDto {
  @ApiProperty({
    description: 'User unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  userId: string;

  @ApiProperty({
    description: 'Aggregated trust score in the range [0, 100]',
    example: 72.5,
    minimum: 0,
    maximum: 100,
  })
  score: number;

  @ApiProperty({
    description: 'Total number of distinct groups the user has participated in',
    example: 5,
  })
  totalGroupsParticipated: number;

  @ApiProperty({
    description: 'Contributions submitted on or before the round deadline',
    example: 18,
  })
  onTimeContributions: number;

  @ApiProperty({
    description: 'Contributions submitted after the round deadline',
    example: 2,
  })
  lateContributions: number;

  @ApiProperty({
    description: 'Rounds where no contribution was ever submitted',
    example: 0,
  })
  missedContributions: number;

  @ApiProperty({
    description: 'Total number of penalties ever incurred',
    example: 1,
  })
  penaltiesIncurred: number;

  @ApiProperty({
    description: 'Number of incurred penalties that have been paid',
    example: 1,
  })
  penaltiesPaid: number;

  @ApiProperty({
    description: 'Groups where the user participated through all rounds to completion',
    example: 3,
  })
  groupsCompletedSuccessfully: number;

  @ApiPropertyOptional({
    description: 'Timestamp of the most recent score calculation (ISO 8601)',
    example: '2026-04-28T02:00:00.000Z',
    nullable: true,
  })
  lastCalculatedAt: string | null;

  @ApiProperty({
    description: 'Record creation timestamp (ISO 8601)',
    example: '2026-01-01T00:00:00.000Z',
  })
  createdAt: string;

  @ApiProperty({
    description: 'Last update timestamp (ISO 8601)',
    example: '2026-04-28T02:00:00.000Z',
  })
  updatedAt: string;
}
