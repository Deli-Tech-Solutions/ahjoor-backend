import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { KycService } from '../kyc.service';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycStatus } from '../entities/kyc-status.enum';
import { User } from '../../users/entities/user.entity';
import { NotificationsService } from '../../notification/notifications.service';
import { NotificationType } from '../../notification/notification-type.enum';
import { WinstonLogger } from '../../common/logger/winston.logger';
import { KycProviderOrchestrator } from '../providers/kyc-provider-orchestrator.service';

const mockUser = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-uuid-1',
    walletAddress: 'GTEST',
    kycStatus: null,
    ...overrides,
  }) as User;

const mockDoc = (overrides: Partial<KycDocument> = {}): KycDocument =>
  ({
    id: 'doc-uuid-1',
    userId: 'user-uuid-1',
    storageKey: 'kyc/user-uuid-1/file.pdf',
    url: 'http://localhost:3000/uploads/kyc/user-uuid-1/file.pdf',
    mimeType: 'application/pdf',
    fileSize: 1024,
    originalName: 'passport.pdf',
    uploadedAt: new Date('2024-01-01'),
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  }) as KycDocument;

const makeFile = (
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File =>
  ({
    fieldname: 'document',
    originalname: 'passport.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('fake-pdf'),
    ...overrides,
  }) as Express.Multer.File;

type MockRepo<T> = Partial<Record<keyof T, jest.Mock>>;

const createMockRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

describe('KycService', () => {
  let service: KycService;
  let kycDocRepo: ReturnType<typeof createMockRepo>;
  let userRepo: ReturnType<typeof createMockRepo>;
  let notificationsService: { notify: jest.Mock };
  let configService: { get: jest.Mock };
  let logger: { log: jest.Mock; error: jest.Mock; warn: jest.Mock };
  let providerOrchestrator: { submitOrReuse: jest.Mock };

  beforeEach(async () => {
    kycDocRepo = createMockRepo();
    userRepo = createMockRepo();
    notificationsService = { notify: jest.fn().mockResolvedValue({}) };
    providerOrchestrator = {
      submitOrReuse: jest.fn().mockImplementation((_user, doc) =>
        Promise.resolve({ ...doc, status: KycStatus.PENDING }),
      ),
    };
    configService = {
      get: jest.fn((key: string, fallback?: any) => {
        const map: Record<string, any> = {
          AWS_S3_BUCKET: null,
          LOCAL_STORAGE_PATH: '/tmp/uploads',
          BASE_URL: 'http://localhost:3000',
        };
        return map[key] ?? fallback;
      }),
    };
    logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: getRepositoryToken(KycDocument), useValue: kycDocRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: ConfigService, useValue: configService },
        { provide: WinstonLogger, useValue: logger },
        { provide: KycProviderOrchestrator, useValue: providerOrchestrator },
      ],
    }).compile();

    service = module.get<KycService>(KycService);

    // Stub local upload to avoid real FS
    jest
      .spyOn(service as any, 'uploadToLocal')
      .mockResolvedValue(
        'http://localhost:3000/uploads/kyc/user-uuid-1/file.pdf',
      );
  });

  afterEach(() => jest.clearAllMocks());

  describe('uploadDocument', () => {
    it('should upload a PDF and return the saved document', async () => {
      const file = makeFile();
      const user = mockUser();
      const doc = mockDoc();

      userRepo.findOne.mockResolvedValue(user);
      kycDocRepo.create.mockReturnValue(doc);
      kycDocRepo.save.mockResolvedValue(doc);
      userRepo.update.mockResolvedValue({});

      const result = await service.uploadDocument('user-uuid-1', file);

      expect(kycDocRepo.save).toHaveBeenCalled();
      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        kycStatus: KycStatus.PENDING,
      });
      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.KYC_SUBMITTED }),
      );
      expect(providerOrchestrator.submitOrReuse).toHaveBeenCalledWith(
        user,
        doc,
        file.buffer,
      );
      expect(result).toEqual({ ...doc, status: KycStatus.PENDING });
    });

    it('sets kycStatus from the orchestrator result (e.g. NEEDS_REVIEW when both providers fail)', async () => {
      const file = makeFile();
      const user = mockUser();
      const doc = mockDoc();

      userRepo.findOne.mockResolvedValue(user);
      kycDocRepo.create.mockReturnValue(doc);
      kycDocRepo.save.mockResolvedValue(doc);
      userRepo.update.mockResolvedValue({});
      providerOrchestrator.submitOrReuse.mockResolvedValue({
        ...doc,
        status: KycStatus.NEEDS_REVIEW,
      });

      await service.uploadDocument('user-uuid-1', file);

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        kycStatus: KycStatus.NEEDS_REVIEW,
      });
    });

    it('should upload a JPEG successfully', async () => {
      const file = makeFile({ originalname: 'id.jpg', mimetype: 'image/jpeg' });
      userRepo.findOne.mockResolvedValue(mockUser());
      kycDocRepo.create.mockReturnValue(mockDoc({ mimeType: 'image/jpeg' }));
      kycDocRepo.save.mockResolvedValue(mockDoc({ mimeType: 'image/jpeg' }));
      userRepo.update.mockResolvedValue({});

      await expect(
        service.uploadDocument('user-uuid-1', file),
      ).resolves.toBeDefined();
    });

    it('should upload a PNG successfully', async () => {
      const file = makeFile({ originalname: 'id.png', mimetype: 'image/png' });
      userRepo.findOne.mockResolvedValue(mockUser());
      kycDocRepo.create.mockReturnValue(mockDoc({ mimeType: 'image/png' }));
      kycDocRepo.save.mockResolvedValue(mockDoc({ mimeType: 'image/png' }));
      userRepo.update.mockResolvedValue({});

      await expect(
        service.uploadDocument('user-uuid-1', file),
      ).resolves.toBeDefined();
    });

    it('should throw UnsupportedMediaTypeException for disallowed MIME type', async () => {
      const file = makeFile({
        mimetype: 'image/gif',
        originalname: 'anim.gif',
      });

      await expect(service.uploadDocument('user-uuid-1', file)).rejects.toThrow(
        UnsupportedMediaTypeException,
      );
      expect(kycDocRepo.save).not.toHaveBeenCalled();
    });

    it('should throw UnsupportedMediaTypeException for text/plain', async () => {
      const file = makeFile({
        mimetype: 'text/plain',
        originalname: 'doc.txt',
      });

      await expect(service.uploadDocument('user-uuid-1', file)).rejects.toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it('should throw PayloadTooLargeException when file exceeds 5 MB', async () => {
      const file = makeFile({ size: 5 * 1024 * 1024 + 1 });

      await expect(service.uploadDocument('user-uuid-1', file)).rejects.toThrow(
        PayloadTooLargeException,
      );
      expect(kycDocRepo.save).not.toHaveBeenCalled();
    });

    it('should allow file exactly at 5 MB boundary', async () => {
      const file = makeFile({ size: 5 * 1024 * 1024 });
      userRepo.findOne.mockResolvedValue(mockUser());
      kycDocRepo.create.mockReturnValue(mockDoc());
      kycDocRepo.save.mockResolvedValue(mockDoc());
      userRepo.update.mockResolvedValue({});

      await expect(
        service.uploadDocument('user-uuid-1', file),
      ).resolves.toBeDefined();
    });

    it('should throw NotFoundException when user does not exist', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.uploadDocument('non-existent', makeFile()),
      ).rejects.toThrow(NotFoundException);
    });

    it('should set kycStatus to PENDING after upload', async () => {
      userRepo.findOne.mockResolvedValue(mockUser());
      kycDocRepo.create.mockReturnValue(mockDoc());
      kycDocRepo.save.mockResolvedValue(mockDoc());
      userRepo.update.mockResolvedValue({});

      await service.uploadDocument('user-uuid-1', makeFile());

      expect(userRepo.update).toHaveBeenCalledWith('user-uuid-1', {
        kycStatus: KycStatus.PENDING,
      });
    });
  });

  describe('getLatestDocument', () => {
    it('should return the latest document with kycStatus', async () => {
      const user = mockUser({ kycStatus: KycStatus.PENDING });
      const doc = mockDoc();

      userRepo.findOne.mockResolvedValue(user);
      kycDocRepo.findOne.mockResolvedValue(doc);

      const result = await service.getLatestDocument('user-uuid-1');

      expect(result.id).toBe(doc.id);
      expect(result.kycStatus).toBe(KycStatus.PENDING);
    });

    it('should throw NotFoundException when user does not exist', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.getLatestDocument('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when no document exists', async () => {
      userRepo.findOne.mockResolvedValue(mockUser());
      kycDocRepo.findOne.mockResolvedValue(null);

      await expect(service.getLatestDocument('user-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
