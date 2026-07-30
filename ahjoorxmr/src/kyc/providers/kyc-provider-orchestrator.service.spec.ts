import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { KycProviderOrchestrator } from './kyc-provider-orchestrator.service';
import { PersonaProviderClient } from './clients/persona-provider-client.service';
import { JumioProviderClient } from './clients/jumio-provider-client.service';
import { OnfidoProviderClient } from './clients/onfido-provider-client.service';
import { AuditService } from '../../audit/audit.service';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycStatus } from '../entities/kyc-status.enum';
import { KycProvider } from '../enums/kyc-provider.enum';
import { User } from '../../users/entities/user.entity';

const mockUser = (): User => ({ id: 'user-1', email: 'user@example.com' } as User);

const mockNewDoc = (): KycDocument =>
  ({
    id: 'doc-new',
    userId: 'user-1',
    url: 'https://example.com/doc.pdf',
    status: KycStatus.PENDING,
  } as KycDocument);

describe('KycProviderOrchestrator', () => {
  let orchestrator: KycProviderOrchestrator;
  let kycDocRepo: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let personaClient: { provider: KycProvider; submitVerification: jest.Mock };
  let jumioClient: { provider: KycProvider; submitVerification: jest.Mock };
  let onfidoClient: { provider: KycProvider; submitVerification: jest.Mock };
  let configValues: Record<string, unknown>;
  let queryBuilderGetOne: jest.Mock;

  beforeEach(async () => {
    queryBuilderGetOne = jest.fn().mockResolvedValue(null);
    const queryBuilder: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: queryBuilderGetOne,
    };

    kycDocRepo = {
      save: jest.fn().mockImplementation((doc) => Promise.resolve(doc)),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    auditService = { createLog: jest.fn().mockResolvedValue({}) };
    personaClient = { provider: KycProvider.PERSONA, submitVerification: jest.fn() };
    jumioClient = { provider: KycProvider.JUMIO, submitVerification: jest.fn() };
    onfidoClient = { provider: KycProvider.ONFIDO, submitVerification: jest.fn() };

    configValues = {
      KYC_PROVIDER_SUBMIT_TIMEOUT_MS: 8000,
      KYC_CASE_REUSE_WINDOW_HOURS: 24,
      KYC_PROVIDER: KycProvider.PERSONA,
      KYC_SECONDARY_PROVIDER: KycProvider.JUMIO,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycProviderOrchestrator,
        { provide: getRepositoryToken(KycDocument), useValue: kycDocRepo },
        { provide: AuditService, useValue: auditService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, def: unknown) => configValues[key] ?? def) },
        },
        { provide: PersonaProviderClient, useValue: personaClient },
        { provide: JumioProviderClient, useValue: jumioClient },
        { provide: OnfidoProviderClient, useValue: onfidoClient },
      ],
    }).compile();

    orchestrator = module.get(KycProviderOrchestrator);
  });

  it('reuses an existing valid case without calling any provider', async () => {
    const existing = {
      id: 'doc-old',
      provider: KycProvider.PERSONA,
      providerCaseId: 'case-123',
      providerStatus: 'pending',
      submittedAt: new Date(),
      caseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastProviderEventAt: null,
    } as KycDocument;
    queryBuilderGetOne.mockResolvedValue(existing);

    const result = await orchestrator.submitOrReuse(mockUser(), mockNewDoc(), Buffer.from('file'));

    expect(personaClient.submitVerification).not.toHaveBeenCalled();
    expect(jumioClient.submitVerification).not.toHaveBeenCalled();
    expect(result.provider).toBe(KycProvider.PERSONA);
    expect(result.providerCaseId).toBe('case-123');
    expect(result.status).toBe(KycStatus.PENDING);
    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'KYC_PROVIDER_CASE_REUSED' }),
    );
  });

  it('AC#3: fails over to the secondary provider when the primary times out', async () => {
    personaClient.submitVerification.mockRejectedValue(new Error('timeout of 8000ms exceeded'));
    jumioClient.submitVerification.mockResolvedValue({
      providerCaseId: 'jumio-case-456',
      providerStatus: 'pending',
    });

    const result = await orchestrator.submitOrReuse(mockUser(), mockNewDoc(), Buffer.from('file'));

    expect(personaClient.submitVerification).toHaveBeenCalled();
    expect(jumioClient.submitVerification).toHaveBeenCalled();
    expect(result.provider).toBe(KycProvider.JUMIO);
    expect(result.providerCaseId).toBe('jumio-case-456');
    expect(result.status).toBe(KycStatus.PENDING);

    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KYC_PROVIDER_SUBMIT_FAILED',
        metadata: expect.objectContaining({ provider: KycProvider.PERSONA }),
      }),
    );
    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KYC_PROVIDER_FAILOVER',
        metadata: expect.objectContaining({
          fromProvider: KycProvider.PERSONA,
          toProvider: KycProvider.JUMIO,
          providerCaseId: 'jumio-case-456',
        }),
      }),
    );
  });

  it('flags the case NEEDS_REVIEW when both providers fail', async () => {
    personaClient.submitVerification.mockRejectedValue(new Error('primary down'));
    jumioClient.submitVerification.mockRejectedValue(new Error('secondary down too'));

    const result = await orchestrator.submitOrReuse(mockUser(), mockNewDoc(), Buffer.from('file'));

    expect(result.status).toBe(KycStatus.NEEDS_REVIEW);
    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'KYC_ALL_PROVIDERS_FAILED' }),
    );
  });

  it('submits fresh to the primary provider with no failover when it succeeds', async () => {
    personaClient.submitVerification.mockResolvedValue({
      providerCaseId: 'case-789',
      providerStatus: 'pending',
    });

    const result = await orchestrator.submitOrReuse(mockUser(), mockNewDoc(), Buffer.from('file'));

    expect(jumioClient.submitVerification).not.toHaveBeenCalled();
    expect(result.provider).toBe(KycProvider.PERSONA);
    expect(result.providerCaseId).toBe('case-789');
    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'KYC_PROVIDER_SUBMITTED' }),
    );
  });

  it('does not fail over when no secondary provider is configured', async () => {
    configValues.KYC_SECONDARY_PROVIDER = '';
    personaClient.submitVerification.mockRejectedValue(new Error('primary down'));

    const result = await orchestrator.submitOrReuse(mockUser(), mockNewDoc(), Buffer.from('file'));

    expect(jumioClient.submitVerification).not.toHaveBeenCalled();
    expect(result.status).toBe(KycStatus.NEEDS_REVIEW);
  });
});
