import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { KycService } from '../kyc.service';
import { KycDocument } from '../entities/kyc-document.entity';
import { User } from '../../users/entities/user.entity';
import { NotificationsService } from '../../notification/notifications.service';
import { WinstonLogger } from '../../common/logger/winston.logger';
import { KycProviderOrchestrator } from '../providers/kyc-provider-orchestrator.service';

const mockUser = { id: 'user-uuid', email: 'test@example.com', kycStatus: null };

// JPEG magic bytes
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(100).fill(0)]);
// PNG magic bytes
const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(100).fill(0)]);
// PDF magic bytes
const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(100).fill(0)]);
// Fake EXE (MZ header)
const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Array(100).fill(0)]);

function makeFile(buffer: Buffer, mimetype = 'image/jpeg', originalname = 'test.jpg'): Express.Multer.File {
  return { buffer, mimetype, originalname, size: buffer.length, fieldname: 'document', encoding: '7bit', stream: null as any, destination: '', filename: '', path: '' };
}

describe('KycService – file validation (issue #223)', () => {
  let service: KycService;
  let kycDocRepo: any;
  let userRepo: any;

  beforeEach(async () => {
    kycDocRepo = {
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve({ ...v, id: 'doc-uuid' })),
      findOne: jest.fn(),
    };
    userRepo = {
      findOne: jest.fn().mockResolvedValue(mockUser),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KycService,
        { provide: getRepositoryToken(KycDocument), useValue: kycDocRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: NotificationsService, useValue: { notify: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: any) => {
              if (key === 'KYC_MAX_FILE_SIZE_MB') return 10;
              if (key === 'CLAMAV_HOST') return null; // disabled
              if (key === 'CLAMAV_PORT') return 3310;
              if (key === 'AWS_S3_BUCKET') return null; // local storage
              if (key === 'LOCAL_STORAGE_PATH') return '/tmp/uploads';
              if (key === 'BASE_URL') return 'http://localhost:3000';
              return def;
            }),
          },
        },
        { provide: WinstonLogger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
        {
          provide: KycProviderOrchestrator,
          useValue: {
            submitOrReuse: jest.fn((_user, doc) => Promise.resolve(doc)),
          },
        },
      ],
    }).compile();

    service = module.get<KycService>(KycService);
  });

  it('accepts a valid JPEG file', async () => {
    const file = makeFile(jpegBuffer, 'image/jpeg', 'photo.jpg');
    // Mock local file write
    jest.spyOn(require('fs/promises'), 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(require('fs/promises'), 'writeFile').mockResolvedValue(undefined);

    await expect(service.uploadDocument('user-uuid', file)).resolves.toBeDefined();
  });

  it('rejects a file with spoofed Content-Type (EXE disguised as JPEG)', async () => {
    const file = makeFile(exeBuffer, 'image/jpeg', 'malware.jpg');
    await expect(service.uploadDocument('user-uuid', file)).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('rejects a file exceeding the size limit', async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0xff); // 11 MB
    // Add JPEG magic bytes
    bigBuffer[0] = 0xff; bigBuffer[1] = 0xd8; bigBuffer[2] = 0xff;
    const file = makeFile(bigBuffer, 'image/jpeg', 'big.jpg');
    file.size = bigBuffer.length;
    await expect(service.uploadDocument('user-uuid', file)).rejects.toThrow(PayloadTooLargeException);
  });

  it('accepts a valid PDF file', async () => {
    const file = makeFile(pdfBuffer, 'application/pdf', 'doc.pdf');
    jest.spyOn(require('fs/promises'), 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(require('fs/promises'), 'writeFile').mockResolvedValue(undefined);

    await expect(service.uploadDocument('user-uuid', file)).resolves.toBeDefined();
  });

  it('skips virus scan and logs warning when CLAMAV_HOST is not set', async () => {
    const file = makeFile(jpegBuffer, 'image/jpeg', 'photo.jpg');
    jest.spyOn(require('fs/promises'), 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(require('fs/promises'), 'writeFile').mockResolvedValue(undefined);

    // Should not throw even without ClamAV
    await expect(service.uploadDocument('user-uuid', file)).resolves.toBeDefined();
  });
});
