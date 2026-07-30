import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycStatus } from '../entities/kyc-status.enum';
import { KycProvider } from '../enums/kyc-provider.enum';
import { User } from '../../users/entities/user.entity';
import { AuditService } from '../../audit/audit.service';
import { KycProviderClient } from './kyc-provider-client.interface';
import { PersonaProviderClient } from './clients/persona-provider-client.service';
import { JumioProviderClient } from './clients/jumio-provider-client.service';
import { OnfidoProviderClient } from './clients/onfido-provider-client.service';

const ACTIVE_STATUSES = [KycStatus.PENDING, KycStatus.NEEDS_REVIEW];

@Injectable()
export class KycProviderOrchestrator {
  private readonly logger = new Logger(KycProviderOrchestrator.name);
  private readonly clients: Map<KycProvider, KycProviderClient>;

  constructor(
    @InjectRepository(KycDocument)
    private readonly kycDocRepo: Repository<KycDocument>,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
    personaClient: PersonaProviderClient,
    jumioClient: JumioProviderClient,
    onfidoClient: OnfidoProviderClient,
  ) {
    this.clients = new Map([
      [KycProvider.PERSONA, personaClient],
      [KycProvider.JUMIO, jumioClient],
      [KycProvider.ONFIDO, onfidoClient],
    ]);
  }

  /**
   * Reuses a still-valid in-flight provider case for this user if one
   * exists, otherwise submits to the primary provider and fails over to a
   * configured secondary provider on timeout/error. Always returns the
   * saved, updated document.
   */
  async submitOrReuse(
    user: User,
    newDoc: KycDocument,
    fileBuffer: Buffer,
  ): Promise<KycDocument> {
    newDoc.documentSetHash = crypto
      .createHash('sha256')
      .update(fileBuffer)
      .digest('hex');

    const reusable = await this.findReusableCase(user.id, newDoc.id);
    if (reusable) {
      return this.reuseCase(user, newDoc, reusable);
    }

    return this.submitFresh(user, newDoc);
  }

  private async findReusableCase(
    userId: string,
    excludeDocId: string,
  ): Promise<KycDocument | null> {
    const now = new Date();
    return this.kycDocRepo
      .createQueryBuilder('doc')
      .where('doc.userId = :userId', { userId })
      .andWhere('doc.id != :excludeDocId', { excludeDocId })
      .andWhere('doc.providerCaseId IS NOT NULL')
      .andWhere('doc.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere(
        '(doc.caseExpiresAt IS NULL OR doc.caseExpiresAt > :now)',
        { now },
      )
      .orderBy('doc.uploadedAt', 'DESC')
      .getOne();
  }

  private async reuseCase(
    user: User,
    newDoc: KycDocument,
    existing: KycDocument,
  ): Promise<KycDocument> {
    newDoc.provider = existing.provider;
    newDoc.providerCaseId = existing.providerCaseId;
    newDoc.providerStatus = existing.providerStatus;
    newDoc.status = KycStatus.PENDING;
    newDoc.submittedAt = existing.submittedAt;
    newDoc.caseExpiresAt = existing.caseExpiresAt;
    newDoc.lastProviderEventAt = existing.lastProviderEventAt;

    const saved = await this.kycDocRepo.save(newDoc);

    await this.auditService.createLog({
      userId: user.id,
      action: 'KYC_PROVIDER_CASE_REUSED',
      resource: 'kyc_document',
      metadata: {
        userId: user.id,
        provider: existing.provider,
        providerCaseId: existing.providerCaseId,
        reusedFromDocumentId: existing.id,
        documentId: saved.id,
      },
    });

    this.logger.log(
      `Reused provider case ${existing.providerCaseId} (${existing.provider}) for userId=${user.id}`,
    );

    return saved;
  }

  private async submitFresh(
    user: User,
    newDoc: KycDocument,
  ): Promise<KycDocument> {
    const timeoutMs = this.config.get<number>(
      'KYC_PROVIDER_SUBMIT_TIMEOUT_MS',
      8000,
    );
    const reuseWindowHours = this.config.get<number>(
      'KYC_CASE_REUSE_WINDOW_HOURS',
      24,
    );
    const primary = this.config.get<string>(
      'KYC_PROVIDER',
      KycProvider.PERSONA,
    ) as KycProvider;
    const secondary = this.config.get<string>(
      'KYC_SECONDARY_PROVIDER',
      '',
    ) as KycProvider | '';

    const params = {
      userId: user.id,
      documentId: newDoc.id,
      documentUrl: newDoc.url,
      documentSetHash: newDoc.documentSetHash ?? '',
    };

    const primaryResult = await this.trySubmit(primary, params, timeoutMs, user.id);
    if (primaryResult) {
      return this.persistSubmission(
        newDoc,
        primary,
        primaryResult.providerCaseId,
        primaryResult.providerStatus,
        reuseWindowHours,
        'KYC_PROVIDER_SUBMITTED',
        { userId: user.id, provider: primary, providerCaseId: primaryResult.providerCaseId },
      );
    }

    if (secondary && secondary !== primary) {
      const secondaryResult = await this.trySubmit(secondary, params, timeoutMs, user.id);
      if (secondaryResult) {
        const saved = await this.persistSubmission(
          newDoc,
          secondary,
          secondaryResult.providerCaseId,
          secondaryResult.providerStatus,
          reuseWindowHours,
          'KYC_PROVIDER_FAILOVER',
          {
            userId: user.id,
            fromProvider: primary,
            toProvider: secondary,
            reason: 'primary_provider_unavailable',
            providerCaseId: secondaryResult.providerCaseId,
          },
        );
        this.logger.warn(
          `Failed over from ${primary} to ${secondary} for userId=${user.id}, case=${secondaryResult.providerCaseId}`,
        );
        return saved;
      }
    }

    // Both providers unavailable (or no secondary configured) — don't strand
    // the user silently; flag for manual review instead of erroring the upload.
    newDoc.status = KycStatus.NEEDS_REVIEW;
    newDoc.lastProviderEventAt = new Date();
    const saved = await this.kycDocRepo.save(newDoc);

    await this.auditService.createLog({
      userId: user.id,
      action: 'KYC_ALL_PROVIDERS_FAILED',
      resource: 'kyc_document',
      metadata: { userId: user.id, primary, secondary: secondary || null, documentId: saved.id },
    });

    return saved;
  }

  private async trySubmit(
    provider: KycProvider,
    params: { userId: string; documentId: string; documentUrl: string; documentSetHash: string },
    timeoutMs: number,
    userId: string,
  ): Promise<{ providerCaseId: string; providerStatus: string } | null> {
    const client = this.clients.get(provider);
    if (!client) {
      this.logger.error(`No provider client registered for ${provider}`);
      return null;
    }

    try {
      return await client.submitVerification(params, timeoutMs);
    } catch (error) {
      this.logger.warn(
        `Provider ${provider} submission failed for userId=${userId}: ${(error as Error).message}`,
      );
      await this.auditService.createLog({
        userId,
        action: 'KYC_PROVIDER_SUBMIT_FAILED',
        resource: 'kyc_document',
        metadata: { userId, provider, error: (error as Error).message },
      });
      return null;
    }
  }

  private async persistSubmission(
    doc: KycDocument,
    provider: KycProvider,
    providerCaseId: string,
    providerStatus: string,
    reuseWindowHours: number,
    auditAction: string,
    auditMetadata: Record<string, unknown>,
  ): Promise<KycDocument> {
    const now = new Date();
    doc.provider = provider;
    doc.providerCaseId = providerCaseId;
    doc.providerStatus = providerStatus;
    doc.status = KycStatus.PENDING;
    doc.submittedAt = now;
    doc.lastProviderEventAt = now;
    doc.caseExpiresAt = new Date(now.getTime() + reuseWindowHours * 60 * 60 * 1000);

    const saved = await this.kycDocRepo.save(doc);

    await this.auditService.createLog({
      userId: doc.userId,
      action: auditAction,
      resource: 'kyc_document',
      metadata: { ...auditMetadata, documentId: saved.id },
    });

    return saved;
  }
}
