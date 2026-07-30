import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { KycDocument } from './entities/kyc-document.entity';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycWebhookService } from './kyc-webhook.service';
import { WebhookHmacGuard } from './guards/webhook-hmac.guard';
import { KycProviderFactory } from './providers/kyc-provider.factory';
import { KycProviderOrchestrator } from './providers/kyc-provider-orchestrator.service';
import { PersonaProviderClient } from './providers/clients/persona-provider-client.service';
import { JumioProviderClient } from './providers/clients/jumio-provider-client.service';
import { OnfidoProviderClient } from './providers/clients/onfido-provider-client.service';
import { KycStuckCaseDetectorService } from './services/kyc-stuck-case-detector.service';
import { User } from '../users/entities/user.entity';
import { NotificationsModule } from '../notification/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { WinstonLogger } from '../common/logger/winston.logger';

@Module({
  imports: [
    TypeOrmModule.forFeature([KycDocument, User]),
    NotificationsModule,
    ConfigModule,
    AuditModule,
  ],
  controllers: [KycController, KycWebhookController],
  providers: [
    KycService,
    WinstonLogger,
    KycWebhookService,
    WebhookHmacGuard,
    KycProviderFactory,
    KycProviderOrchestrator,
    KycStuckCaseDetectorService,
    PersonaProviderClient,
    JumioProviderClient,
    OnfidoProviderClient,
  ],
  exports: [KycService, KycStuckCaseDetectorService],
})
export class KycModule {}
