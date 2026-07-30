import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { KycStuckCaseDetectorService } from './kyc-stuck-case-detector.service';
import { AuditService } from '../../audit/audit.service';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycStatus } from '../entities/kyc-status.enum';
import { KycProvider } from '../enums/kyc-provider.enum';

describe('KycStuckCaseDetectorService', () => {
  let service: KycStuckCaseDetectorService;
  let kycDocRepo: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let getMany: jest.Mock;

  beforeEach(async () => {
    getMany = jest.fn().mockResolvedValue([]);
    const queryBuilder: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany,
    };

    kycDocRepo = {
      save: jest.fn().mockImplementation((doc) => Promise.resolve(doc)),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    auditService = { createLog: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycStuckCaseDetectorService,
        { provide: getRepositoryToken(KycDocument), useValue: kycDocRepo },
        { provide: AuditService, useValue: auditService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(48) },
        },
      ],
    }).compile();

    service = module.get(KycStuckCaseDetectorService);
  });

  it('flags a case past the configurable timeout with no provider event', async () => {
    const staleDoc = {
      id: 'doc-1',
      userId: 'user-1',
      status: KycStatus.PENDING,
      provider: KycProvider.PERSONA,
      providerCaseId: 'case-1',
      lastProviderEventAt: null,
      submittedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      uploadedAt: new Date(Date.now() - 73 * 60 * 60 * 1000),
      stuckFlaggedAt: null,
    } as unknown as KycDocument;
    getMany.mockResolvedValue([staleDoc]);

    const result = await service.detectAndFlagStuckCases();

    expect(result.flaggedCount).toBe(1);
    expect(kycDocRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1', stuckFlaggedAt: expect.any(Date) }),
    );
    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KYC_STUCK_PENDING_FLAGGED',
        userId: 'user-1',
        metadata: expect.objectContaining({ documentId: 'doc-1', providerCaseId: 'case-1' }),
      }),
    );
  });

  it('does not flag any cases when the query returns none (within the window)', async () => {
    getMany.mockResolvedValue([]);

    const result = await service.detectAndFlagStuckCases();

    expect(result.flaggedCount).toBe(0);
    expect(kycDocRepo.save).not.toHaveBeenCalled();
    expect(auditService.createLog).not.toHaveBeenCalled();
  });

  it('excludes already-flagged cases via the stuckFlaggedAt IS NULL query filter', async () => {
    // The already-flagged filter is expressed in the query itself
    // (doc.stuckFlaggedAt IS NULL) rather than in application code, so an
    // already-flagged doc simply never appears in getMany()'s result.
    getMany.mockResolvedValue([]);

    await service.detectAndFlagStuckCases();

    const queryBuilder = kycDocRepo.createQueryBuilder.mock.results[0].value;
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('doc.stuckFlaggedAt IS NULL');
  });
});
