import { Module, OnApplicationShutdown, Logger, Inject } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './common/redis/redis.module';
import { CacheInterceptor } from './common/interceptors/cache.interceptor';
import { PiiScrubbingInterceptor } from './common/interceptors/pii-scrubbing.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { SlowRequestInterceptor } from './common/interceptors/slow-request.interceptor';
import { WinstonLogger } from './common/logger/winston.logger';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { StellarAuthModule } from './stellar-auth/auth.module';
import { UsersModule } from './users/users.module';
import { GroupsModule } from './groups/groups.module';
import { MembershipsModule } from './memberships/memberships.module';
import { ContributionsModule } from './contributions/contributions.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { Membership } from './memberships/entities/membership.entity';
import { Group } from './groups/entities/group.entity';
import { User } from './users/entities/user.entity';
import { Contribution } from './contributions/entities/contribution.entity';
import { AuditLog } from './audit/entities/audit-log.entity';
import { KycDocument } from './kyc/entities/kyc-document.entity';
import { PayoutTransaction } from './groups/entities/payout-transaction.entity';
import { JobFailure } from './bullmq/entities/job-failure.entity';
import { QueryAnalysis } from './database/entities/query-analysis.entity';
import { ApiKey } from './api-keys/entities/api-key.entity';
import { GroupInvite } from './groups/entities/group-invite.entity';
import { KycModule } from './kyc/kyc.module';
import { StellarModule } from './stellar/stellar.module';
import { EventListenerModule } from './event-listener/event-listener.module';
import { CustomThrottlerModule } from './throttler/throttler.module';
import { AuditModule } from './audit/audit.module';
import { SeedModule } from './database/seeds/seed.module';
import { DatabasePerformanceModule } from './database/database-performance.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { CommonModule } from './common/common.module';
import { MailModule } from './mail/mail.module';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { ProxyHopMiddleware } from './common/middleware/proxy-hop.middleware';
import { ReplicaModule } from './database/replica.module';
import { DatabaseRoutingModule } from './database/database-routing.module';
import { ReadReplicaInterceptor } from './common/interceptors/read-replica.interceptor';
import { ReadQueryRunner } from './database/read-query-runner';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { WebhookModule } from './webhooks/webhook.module';
import { PaymentsModule } from './payments/payments.module';
import { AdminModule } from './admin/admin.module';
import { PenaltiesModule } from './penalties/penalties.module';
import { Penalty } from './penalties/entities/penalty.entity';
import { NotificationPreference } from './notification/notification-preference.entity';
import { MaintenanceModeGuard } from './common/guards/maintenance-mode.guard';
import { WaitlistModule } from './waitlist/waitlist.module';
import { GroupWaitlist } from './waitlist/entities/group-waitlist.entity';
import { TrustScoreModule } from './trust-score/trust-score.module';
import { MemberTrustScore } from './trust-score/entities/member-trust-score.entity';

@Module({
  imports: [
    // ConfigModule must be first to make environment variables available
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // TypeORM configuration with PostgreSQL (Primary)
    TypeOrmModule.forRootAsync({
      name: 'primary',
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const isDevelopment =
          configService.get<string>('NODE_ENV') === 'development';
        return {
          type: 'postgres',
          host: configService.get<string>('DB_HOST') || 'localhost',
          port: parseInt(configService.get<string>('DB_PORT') || '5432', 10),
          username: configService.get<string>('DB_USERNAME') || 'postgres',
          password: configService.get<string>('DB_PASSWORD') || 'postgres',
          database: configService.get<string>('DB_NAME') || 'ahjoorxmr',
          entities: [
            Membership,
            Group,
            User,
            Contribution,
            AuditLog,
            KycDocument,
            PayoutTransaction,
            JobFailure,
            QueryAnalysis,
            ApiKey,
            GroupInvite,
            Penalty,
            NotificationPreference,
            GroupWaitlist,
            MemberTrustScore,
          ],
          synchronize: isDevelopment, // Auto-create tables only in development
          logging: isDevelopment, // Enable logging only in development
          extra: {
            // Query timeout configuration
            statement_timeout: parseInt(
              configService.get<string>('DB_QUERY_TIMEOUT_MS') || '5000',
              10,
            ),
            query_timeout: parseInt(
              configService.get<string>('DB_QUERY_TIMEOUT_MS') || '5000',
              10,
            ),
          },
        };
      },
      inject: [ConfigService],
    }),

    // Replica and Routing Modules
    ReplicaModule,
    DatabaseRoutingModule,

    // RedisModule for caching and session management
    RedisModule,
    CustomThrottlerModule,
    SchedulerModule,
    HealthModule,
    AuthModule,
    StellarAuthModule,
    UsersModule,
    GroupsModule,
    MembershipsModule,
    ContributionsModule,
    StellarModule,
    EventListenerModule,
    AuditModule,
    SeedModule,
    KycModule,
    DatabasePerformanceModule,
    FeatureFlagsModule,
    CommonModule,
    MailModule,
    MetricsModule,
    WebhookModule,
    PaymentsModule,
    AdminModule,
    PenaltiesModule,
    WaitlistModule,
    TrustScoreModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    WinstonLogger,
    {
      provide: APP_INTERCEPTOR,
      useClass: PiiScrubbingInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TimeoutInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SlowRequestInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ReadReplicaInterceptor,
    },
    ReadQueryRunner,
    {
      provide: APP_GUARD,
      useClass: MaintenanceModeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: MaintenanceModeGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, ProxyHopMiddleware).forRoutes('*');
  }
}
