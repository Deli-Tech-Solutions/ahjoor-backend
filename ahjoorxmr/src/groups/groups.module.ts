import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GroupsController } from './groups.controller';
import { GroupsV2Controller } from './groups-v2.controller';
import { GroupsService } from './groups.service';
import { RoundService } from './round.service';
import { PayoutService } from './payout.service';
import { Group } from './entities/group.entity';
import { GroupTemplate } from './entities/group-template.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { WinstonLogger } from '../common/logger/winston.logger';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { NotificationsModule } from '../notification/notifications.module';
import { StellarModule } from '../stellar/stellar.module';
import { PayoutTransaction } from './entities/payout-transaction.entity';
import { QueueModule } from '../bullmq/queue.module';
import { GroupInvite } from './entities/group-invite.entity';
import { GroupInviteService } from './invites/group-invite.service';
import { GroupInviteController } from './invites/group-invite.controller';
import { MailModule } from '../mail/mail.module';
import { User } from '../users/entities/user.entity';
import { Announcement } from './entities/announcement.entity';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';
import { AuditModule } from '../audit/audit.module';
import { GroupTemplatesService } from './group-templates.service';
import { GroupTemplatesController } from './group-templates.controller';
import { Contribution } from '../contributions/entities/contribution.entity';
import { FxModule } from '../fx/fx.module';

/**
 * GroupsModule manages ROSCA group entities in the database.
 * It is the source of truth for group state as reflected by the REST API.
 * Smart contract interactions are handled by a separate Stellar service.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Group, GroupTemplate, Membership, PayoutTransaction, GroupInvite, User, Announcement, Contribution]),
    NotificationsModule,
    StellarModule,
    QueueModule,
    MailModule,
    AuditModule,
    FxModule,
  ],
  controllers: [GroupsController, GroupsV2Controller, GroupInviteController, AnnouncementsController, GroupTemplatesController],
  providers: [
    GroupsService,
    RoundService,
    PayoutService,
    WinstonLogger,
    JwtAuthGuard,
    GroupInviteService,
    AnnouncementsService,
    GroupTemplatesService,
  ],
  exports: [GroupsService, RoundService, PayoutService, GroupInviteService, GroupTemplatesService],
})
export class GroupsModule {}
