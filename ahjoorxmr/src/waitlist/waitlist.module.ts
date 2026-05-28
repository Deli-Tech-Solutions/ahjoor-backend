import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';
import { GroupWaitlist } from './entities/group-waitlist.entity';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { NotificationsModule } from '../notification/notifications.module';
import { WinstonLogger } from '../common/logger/winston.logger';
import { JwtAuthGuard } from '../groups/guards/jwt-auth.guard';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GroupWaitlist, Group, Membership]),
    NotificationsModule,
    ConfigModule,
    forwardRef(() => MembershipsModule),
  ],
  controllers: [WaitlistController],
  providers: [WaitlistService, WinstonLogger, JwtAuthGuard],
  exports: [WaitlistService],
})
export class WaitlistModule {}
