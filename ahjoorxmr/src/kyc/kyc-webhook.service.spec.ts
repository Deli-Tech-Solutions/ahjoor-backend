// Avoid pulling in @nestjs-modules/mailer (not installed in this project)
jest.mock('../notification/notifications.service');

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { KycWebhookService } from './kyc-webhook.service';
import { KycProviderFactory } from './providers/kyc-provider.factory';
import { NotificationsService } from '../notification/notifications.service';
import { AuditService } from '../audit/audit.service';
import { User } from '../users/entities/user.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { KycStatus } from './entities/kyc-status.enum';
import { KycProvider } from './enums/kyc-provider.enum';
import { NotificationType } from '../notification/notification-type.enum';

const mockUser = (): User =>
  ({
    id: 'user-uuid-1',
    email: 'user@example.com',
    kycStatus: KycStatus.PENDING,
    walletAddress: null,
    refreshTokenHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as User);

const mockDoc = (): KycDocument =>
  ({
    id: 'doc-1',
    userId: 'user-uuid-1',
    provider: KycProvider.PERSONA,
    providerCaseId: 'inq_abc123',
    status: KycStatus.PENDING,
    uploadedAt: new Date(),
  } as KycDocument);

const mockParsedPayload = {
  userId: 'user-uuid-1',
  providerCaseId: 'inq_abc123',
  status: KycStatus.APPROVED,
  raw: { data: { id: 'inq_abc123' }, status: 'approved' },
};

describe('KycWebhookService', () => {
  let service: KycWebhookService;
  let userRepo: { findOne: jest.Mock; save: jest.Mock };
  let kycDocRepo: { findOne: jest.Mock; save: jest.Mock };
  let providerFactory: { getParser: jest.Mock };
  let notificationsService: { notify: jest.Mock };
  let auditService: { createLog: jest.Mock };
  let mockParser: { validateSignature: jest.Mock; parse: jest.Mock };

  beforeEach(async () => {
    mockParser = { validateSignature: jest.fn(), parse: jest.fn().mockReturnValue(mockParsedPayload) };
    providerFactory = { getParser: jest.fn().mockReturnValue(mockParser) };
    notificationsService = { notify: jest.fn().mockResolvedValue({}) };
    auditService = { createLog: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycWebhookService,
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(KycDocument),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        { provide: KycProviderFactory, useValue: providerFactory },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: AuditService, useValue: auditService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(KycProvider.PERSONA) },
        },
      ],
    }).compile();

    service = module.get(KycWebhookService);
    userRepo = module.get(getRepositoryToken(User));
    kycDocRepo = module.get(getRepositoryToken(KycDocument));
  });

  it('updates User.kycStatus on approved webhook', async () => {
    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue({ ...user, kycStatus: KycStatus.APPROVED });
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'));

    expect(userRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ kycStatus: KycStatus.APPROVED }),
    );
  });

  it('updates the matching KycDocument and clears any stuck flag', async () => {
    const user = mockUser();
    const doc = { ...mockDoc(), stuckFlaggedAt: new Date() };
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(doc);
    kycDocRepo.save.mockResolvedValue(doc);

    await service.processWebhook(Buffer.from('{}'));

    expect(kycDocRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: KycStatus.APPROVED,
        stuckFlaggedAt: null,
      }),
    );
  });

  it('writes a KYC_STATUS_UPDATED audit log entry via AuditService', async () => {
    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'));

    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'KYC_STATUS_UPDATED',
        resource: 'kyc_document',
        userId: 'user-uuid-1',
        metadata: expect.objectContaining({ providerCaseId: 'inq_abc123' }),
      }),
    );
  });

  it('sends KYC_APPROVED email when status is approved', async () => {
    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'));

    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationType.KYC_APPROVED,
        emailTo: user.email,
        sendEmail: true,
      }),
    );
  });

  it('sends KYC_DECLINED email when status is rejected', async () => {
    mockParser.parse.mockReturnValue({ ...mockParsedPayload, status: KycStatus.REJECTED });

    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'));

    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.KYC_DECLINED }),
    );
  });

  it('does NOT send email for needs_review status', async () => {
    mockParser.parse.mockReturnValue({ ...mockParsedPayload, status: KycStatus.NEEDS_REVIEW });

    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'));

    expect(notificationsService.notify).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when user does not exist', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await expect(service.processWebhook(Buffer.from('{}'))).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when no matching document exists', async () => {
    userRepo.findOne.mockResolvedValue(mockUser());
    kycDocRepo.findOne.mockResolvedValue(null);
    await expect(service.processWebhook(Buffer.from('{}'))).rejects.toThrow(NotFoundException);
  });

  it('parses using the provider-specific parser when a provider is detected (failover-aware)', async () => {
    const user = mockUser();
    userRepo.findOne.mockResolvedValue(user);
    userRepo.save.mockResolvedValue(user);
    kycDocRepo.findOne.mockResolvedValue(mockDoc());
    kycDocRepo.save.mockResolvedValue(mockDoc());

    await service.processWebhook(Buffer.from('{}'), KycProvider.JUMIO);

    expect(providerFactory.getParser).toHaveBeenCalledWith(KycProvider.JUMIO);
  });
});
