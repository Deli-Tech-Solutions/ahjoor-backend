import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { AuditLogService } from './services/audit-log.service';
import { ContributionSummaryService } from './services/contribution-summary.service';
import { GroupStatusService } from './services/group-status.service';
import { StaleGroupDetectionService } from './services/stale-group-detection.service';
import { DistributedLockService } from './services/distributed-lock.service';
import { RoundAdvanceService } from './services/round-advance.service';
import { ProfileIncompleteReminderService } from './services/profile-incomplete-reminder.service';
import { AuditLog } from './entities/audit-log.entity';
import { Contribution } from '../contributions/entities/contribution.entity';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notification/notifications.service';
import { GroupsModule } from '../groups/groups.module';
import { NotificationsModule } from '../notification/notifications.module';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../bullmq/queue.constants';
import { QueueService } from '../bullmq/queue.service';
import { ProfileCompletenessService } from '../users/services/profile-completeness.service';
import { PenaltiesModule } from '../penalties/penalties.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([AuditLog, Contribution, Group, Membership, RefreshToken, User]),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.EVENT_SYNC },
      { name: QUEUE_NAMES.GROUP_SYNC },
      { name: QUEUE_NAMES.PAYOUT_RECONCILIATION },
      { name: QUEUE_NAMES.DEAD_LETTER },
      { name: QUEUE_NAMES.TX_CONFIRMATION },
      { name: QUEUE_NAMES.PUSH_NOTIFICATION },
      { name: QUEUE_NAMES.TRUST_SCORE },
    ),
    GroupsModule,
    NotificationsModule,
    PenaltiesModule,
  ],
  providers: [
    SchedulerService,
    AuditLogService,
    ContributionSummaryService,
    GroupStatusService,
    StaleGroupDetectionService,
    DistributedLockService,
    NotificationsService,
    RoundAdvanceService,
    ProfileIncompleteReminderService,
    QueueService,
    ProfileCompletenessService,
  ],
  exports: [AuditLogService],
})
export class SchedulerModule { }
