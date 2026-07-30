import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { StellarService } from './stellar.service';
import { StellarCircuitBreakerService } from './stellar-circuit-breaker.service';
import { CongestionMonitorService } from './congestion-monitor.service';
import { ContractStateGuard } from './contract-state-guard.service';
import { BalanceMonitorService } from './balance-monitor.service';
import { StellarAdminController } from './stellar-admin.controller';
import { WinstonLogger } from '../common/logger/winston.logger';
import { MetricsModule } from '../metrics/metrics.module';
import { Group } from '../groups/entities/group.entity';
import { WebhookModule } from '../webhooks/webhook.module';
import { DistributedLockService } from '../scheduler/services/distributed-lock.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Group]),
    MetricsModule,
    WebhookModule,
  ],
  controllers: [StellarAdminController],
  providers: [
    StellarService,
    CongestionMonitorService,
    StellarCircuitBreakerService,
    ContractStateGuard,
    BalanceMonitorService,
    DistributedLockService,
    WinstonLogger,
  ],
  exports: [
    StellarService,
    CongestionMonitorService,
    StellarCircuitBreakerService,
    ContractStateGuard,
    BalanceMonitorService,
  ],
})
export class StellarModule { }
