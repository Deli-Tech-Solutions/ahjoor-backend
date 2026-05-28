import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MemberTrustScore } from './entities/member-trust-score.entity';
import { TrustScoreService } from './trust-score.service';
import { TrustScoreController } from './trust-score.controller';
import { TrustScoreRecalculationProcessor } from './trust-score-recalculation.processor';
import { Contribution } from '../contributions/entities/contribution.entity';
import { Penalty } from '../penalties/entities/penalty.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { Group } from '../groups/entities/group.entity';
import { User } from '../users/entities/user.entity';
import { QUEUE_NAMES } from '../bullmq/queue.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MemberTrustScore,
      Contribution,
      Penalty,
      Membership,
      Group,
      User,
    ]),
    BullModule.registerQueue({ name: QUEUE_NAMES.TRUST_SCORE }),
    EventEmitterModule.forRoot(),
  ],
  controllers: [TrustScoreController],
  providers: [TrustScoreService, TrustScoreRecalculationProcessor],
  exports: [TrustScoreService],
})
export class TrustScoreModule {}
