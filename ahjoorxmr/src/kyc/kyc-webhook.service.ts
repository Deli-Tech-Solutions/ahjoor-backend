import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { KycStatus } from './entities/kyc-status.enum';
import { KycProviderFactory } from './providers/kyc-provider.factory';
import { KycProvider } from './enums/kyc-provider.enum';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class KycWebhookService {
  private readonly logger = new Logger(KycWebhookService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(KycDocument)
    private readonly kycDocRepo: Repository<KycDocument>,
    private readonly providerFactory: KycProviderFactory,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Process a raw webhook body. `provider` is the provider detected by
   * WebhookHmacGuard from the signature header (undefined falls back to the
   * app's configured default provider) — this matters once a case has
   * failed over to a secondary provider, whose payload shape/status
   * vocabulary differs from the primary.
   */
  async processWebhook(rawBody: Buffer, provider?: KycProvider): Promise<void> {
    const parser = this.providerFactory.getParser(provider);
    const parsed = parser.parse(rawBody);

    const { userId, providerCaseId, status, raw } = parsed;

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.warn(`KYC webhook for unknown userId=${userId}`);
      throw new NotFoundException(`User ${userId} not found`);
    }

    const previousStatus = user.kycStatus;

    const resolvedProvider =
      provider ??
      (this.config.get<string>('KYC_PROVIDER', KycProvider.PERSONA) as KycProvider);

    // Match the case this callback belongs to, not just "latest doc for
    // this user" — a resubmission may have created a newer, unrelated doc.
    let doc = await this.kycDocRepo.findOne({
      where: { userId, providerCaseId },
      order: { uploadedAt: 'DESC' },
    });
    if (!doc) {
      doc = await this.kycDocRepo.findOne({
        where: { userId },
        order: { uploadedAt: 'DESC' },
      });
    }
    if (!doc) {
      this.logger.warn(`KYC webhook with no matching document userId=${userId} case=${providerCaseId}`);
      throw new NotFoundException(`No KYC document found for user ${userId}`);
    }

    const now = new Date();
    doc.status = status;
    doc.provider = doc.provider ?? resolvedProvider;
    doc.providerCaseId = doc.providerCaseId ?? providerCaseId;
    doc.providerStatus = String((raw as Record<string, unknown>)?.['status'] ?? doc.providerStatus ?? '');
    doc.providerPayload = raw;
    doc.lastProviderEventAt = now;
    // A late callback resolves any stuck-pending flag.
    doc.stuckFlaggedAt = null;
    await this.kycDocRepo.save(doc);

    // Update user KYC status
    user.kycStatus = status;
    await this.userRepo.save(user);

    await this.auditService.createLog({
      userId,
      action: 'KYC_STATUS_UPDATED',
      resource: 'kyc_document',
      metadata: {
        previousStatus,
        newStatus: status,
        providerCaseId,
        provider: resolvedProvider,
        documentId: doc.id,
      },
    });

    this.logger.log(
      `KYC status updated userId=${userId} ${previousStatus} → ${status} case=${providerCaseId}`,
    );

    // Send email notification on terminal statuses
    if (status === KycStatus.APPROVED || status === KycStatus.REJECTED) {
      await this.sendKycEmail(user, status);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async sendKycEmail(user: User, status: KycStatus): Promise<void> {
    if (!user.email) {
      this.logger.debug(`No email for userId=${user.id}, skipping KYC email`);
      return;
    }

    const isApproved = status === KycStatus.APPROVED;
    const type = isApproved
      ? NotificationType.KYC_APPROVED
      : NotificationType.KYC_DECLINED;

    const title = isApproved
      ? 'Your identity has been verified'
      : 'Identity verification unsuccessful';

    const body = isApproved
      ? 'Congratulations! Your KYC verification was approved. You now have full access to the platform.'
      : 'Unfortunately your KYC verification was declined. Please re-submit your documents or contact support for assistance.';

    await this.notificationsService.notify({
      userId: user.id,
      type,
      title,
      body,
      sendEmail: true,
      emailTo: user.email,
      emailTemplateData: { status },
    });
  }
}
