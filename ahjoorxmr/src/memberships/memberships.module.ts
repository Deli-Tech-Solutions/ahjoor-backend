import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { Membership } from './entities/membership.entity';
import { Group } from '../groups/entities/group.entity';
import { User } from '../users/entities/user.entity';
import { WinstonLogger } from '../common/logger/winston.logger';
import { NotificationsModule } from '../notification/notifications.module';
import { JwtAuthGuard } from '../groups/guards/jwt-auth.guard';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { MemberTrustScore } from '../trust-score/entities/member-trust-score.entity';

/**
 * MembershipsModule manages the relationship between users and ROSCA groups.
 * Provides REST API endpoints for adding, removing, and listing group members.
 * Enforces business rules around membership lifecycle and data integrity.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Membership, Group, User, MemberTrustScore]),
    NotificationsModule,
    forwardRef(() => WaitlistModule),
  ],
  controllers: [MembershipsController],
  providers: [MembershipsService, WinstonLogger, JwtAuthGuard],
  exports: [MembershipsService],
})
export class MembershipsModule {}
