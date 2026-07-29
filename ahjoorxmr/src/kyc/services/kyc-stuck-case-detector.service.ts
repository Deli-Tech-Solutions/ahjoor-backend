import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycStatus } from '../entities/kyc-status.enum';
import { AuditService } from '../../audit/audit.service';

@Injectable()
export class KycStuckCaseDetectorService {
  private readonly logger = new Logger(KycStuckCaseDetectorService.name);

  constructor(
    @InjectRepository(KycDocument)
    private readonly kycDocRepo: Repository<KycDocument>,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Flags KYC documents that have been PENDING with no provider callback
   * (no webhook event, ever) for longer than KYC_STUCK_PENDING_TIMEOUT_HOURS.
   * Silence from a provider is indistinguishable from "still processing"
   * until this timeout passes, so this is a heuristic, not a hard failure.
   */
  async detectAndFlagStuckCases(): Promise<{ flaggedCount: number }> {
    const timeoutHours = this.config.get<number>(
      'KYC_STUCK_PENDING_TIMEOUT_HOURS',
      48,
    );
    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);

    const stuckDocs = await this.kycDocRepo
      .createQueryBuilder('doc')
      .where('doc.status = :status', { status: KycStatus.PENDING })
      .andWhere('doc.stuckFlaggedAt IS NULL')
      .andWhere(
        'COALESCE(doc."lastProviderEventAt", doc."submittedAt", doc."uploadedAt") < :cutoff',
        { cutoff },
      )
      .getMany();

    for (const doc of stuckDocs) {
      const referenceTime = doc.lastProviderEventAt ?? doc.submittedAt ?? doc.uploadedAt;
      const hoursSinceLastEvent =
        (Date.now() - referenceTime.getTime()) / (60 * 60 * 1000);

      doc.stuckFlaggedAt = new Date();
      await this.kycDocRepo.save(doc);

      await this.auditService.createLog({
        userId: doc.userId,
        action: 'KYC_STUCK_PENDING_FLAGGED',
        resource: 'kyc_document',
        metadata: {
          userId: doc.userId,
          documentId: doc.id,
          provider: doc.provider,
          providerCaseId: doc.providerCaseId,
          hoursSinceLastEvent: Math.round(hoursSinceLastEvent),
        },
      });

      this.logger.warn(
        `Flagged stuck KYC case userId=${doc.userId} documentId=${doc.id} provider=${doc.provider} hoursSinceLastEvent=${Math.round(hoursSinceLastEvent)}`,
      );
    }

    return { flaggedCount: stuckDocs.length };
  }
}
