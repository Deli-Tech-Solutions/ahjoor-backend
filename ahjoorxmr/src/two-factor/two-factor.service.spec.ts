// Stub @nestjs-modules/mailer (not installed) via moduleNameMapper in jest config
jest.mock('../notification/notifications.service');

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { TwoFactorService } from './two-factor.service';
import { NotificationsService } from '../notification/notifications.service';
import { User } from '../users/entities/user.entity';
import { AuditLog } from '../kyc/entities/audit-log.entity';
import { KycStatus } from '../kyc/entities/kyc-status.enum';
import { NotificationType } from '../notification/enums/notification-type.enum';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    walletAddress: null,
    kycStatus: KycStatus.PENDING,
    refreshTokenHash: null,
    twoFaEnabled: true,
    twoFaBackupCodes: null,
    twoFaBackupCodesExhausted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TwoFactorService', () => {
  let service: TwoFactorService;
  let userRepo: { findOne: jest.Mock; save: jest.Mock };
  let auditLogRepo: { find: jest.Mock; save: jest.Mock; create: jest.Mock };
  let notificationsService: { notify: jest.Mock };

  beforeEach(async () => {
    notificationsService = { notify: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            find: jest.fn(),
            save: jest.fn(),
            create: jest.fn((x: unknown) => x),
          },
        },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get(TwoFactorService);
    userRepo = module.get(getRepositoryToken(User));
    auditLogRepo = module.get(getRepositoryToken(AuditLog));
  });

  afterEach(() => jest.clearAllMocks());

  // ─── generateBackupCodes ──────────────────────────────────────────────────

  describe('generateBackupCodes()', () => {
    it('returns BACKUP_CODE_COUNT plaintext codes', async () => {
      const user = makeUser();
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockResolvedValue(user);

      const codes = await service.generateBackupCodes('user-1');

      expect(codes).toHaveLength(10);
      codes.forEach((c) => expect(typeof c).toBe('string'));
    });

    it('persists bcrypt hashes (not plaintext) on the user', async () => {
      const user = makeUser();
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);

      const codes = await service.generateBackupCodes('user-1');

      const saved: User = userRepo.save.mock.calls[0][0] as User;
      expect(saved.twoFaBackupCodes).toHaveLength(10);

      // Hashes must not equal plaintext
      for (let i = 0; i < codes.length; i++) {
        expect(saved.twoFaBackupCodes![i]).not.toBe(codes[i]);
        const match = await bcrypt.compare(codes[i], saved.twoFaBackupCodes![i]);
        expect(match).toBe(true);
      }
    });

    it('resets twoFaBackupCodesExhausted to false', async () => {
      const user = makeUser({ twoFaBackupCodesExhausted: true });
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);

      await service.generateBackupCodes('user-1');

      const saved: User = userRepo.save.mock.calls[0][0] as User;
      expect(saved.twoFaBackupCodesExhausted).toBe(false);
    });

    it('throws NotFoundException for unknown user', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.generateBackupCodes('ghost')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── verifyBackupCode ─────────────────────────────────────────────────────

  describe('verifyBackupCode()', () => {
    const IP = '1.2.3.4';
    const UA = 'Mozilla/5.0';

    async function makeUserWithCodes(count = 3) {
      const plainCodes = Array.from({ length: count }, (_, i) => `code${i}`);
      const hashed = await Promise.all(plainCodes.map((c) => bcrypt.hash(c, 1)));
      return { user: makeUser({ twoFaBackupCodes: hashed }), plainCodes };
    }

    it('throws UnauthorizedException for an invalid code', async () => {
      const { user } = await makeUserWithCodes(2);
      userRepo.findOne.mockResolvedValue(user);

      await expect(
        service.verifyBackupCode('user-1', 'wrong-code', IP, UA),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('removes the consumed code from the array', async () => {
      const { user, plainCodes } = await makeUserWithCodes(3);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[1], IP, UA);

      const saved: User = userRepo.save.mock.calls[0][0] as User;
      expect(saved.twoFaBackupCodes).toHaveLength(2);
    });

    it('writes an AuditLog entry with TWO_FA_BACKUP_CODE_USED eventType', async () => {
      const { user, plainCodes } = await makeUserWithCodes(2);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      expect(auditLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          eventType: 'TWO_FA_BACKUP_CODE_USED',
          metadata: expect.objectContaining({ ipAddress: IP, codeIndex: 0 }),
        }),
      );
    });

    it('sends TWO_FA_BACKUP_CODE_USED email after successful verification', async () => {
      const { user, plainCodes } = await makeUserWithCodes(2);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.TWO_FA_BACKUP_CODE_USED,
          emailTo: user.email,
          sendEmail: true,
        }),
      );
    });

    it('sets twoFaBackupCodesExhausted=true when last code is consumed', async () => {
      const { user, plainCodes } = await makeUserWithCodes(1);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      const saved: User = userRepo.save.mock.calls[0][0] as User;
      expect(saved.twoFaBackupCodesExhausted).toBe(true);
    });

    it('sends TWO_FA_BACKUP_CODES_EXHAUSTED email when last code is consumed', async () => {
      const { user, plainCodes } = await makeUserWithCodes(1);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      expect(notificationsService.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.TWO_FA_BACKUP_CODES_EXHAUSTED,
        }),
      );
    });

    it('does NOT send exhausted email when codes remain', async () => {
      const { user, plainCodes } = await makeUserWithCodes(3);
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      const exhaustedCall = notificationsService.notify.mock.calls.find(
        (args: unknown[]) =>
          (args[0] as { type: NotificationType }).type ===
          NotificationType.TWO_FA_BACKUP_CODES_EXHAUSTED,
      );
      expect(exhaustedCall).toBeUndefined();
    });

    it('does not send email when user has no email address', async () => {
      const { user, plainCodes } = await makeUserWithCodes(1);
      user.email = null;
      userRepo.findOne.mockResolvedValue(user);
      userRepo.save.mockImplementation(async (u: User) => u);
      auditLogRepo.save.mockResolvedValue({});

      await service.verifyBackupCode('user-1', plainCodes[0], IP, UA);

      expect(notificationsService.notify).not.toHaveBeenCalled();
    });
  });

  // ─── getBackupCodeUsage ───────────────────────────────────────────────────

  describe('getBackupCodeUsage()', () => {
    it('returns mapped usage records from AuditLog', async () => {
      const now = new Date();
      auditLogRepo.find.mockResolvedValue([
        {
          id: 'log-1',
          userId: 'user-1',
          eventType: 'TWO_FA_BACKUP_CODE_USED',
          metadata: { ipAddress: '1.2.3.4', codeIndex: 2 },
          createdAt: now,
        },
      ]);

      const result = await service.getBackupCodeUsage('user-1');

      expect(result).toEqual([
        { usedAt: now, ipAddress: '1.2.3.4', codeIndex: 2 },
      ]);
    });

    it('returns empty array when no usage records exist', async () => {
      auditLogRepo.find.mockResolvedValue([]);
      const result = await service.getBackupCodeUsage('user-1');
      expect(result).toEqual([]);
    });

    it('queries AuditLog with correct filters', async () => {
      auditLogRepo.find.mockResolvedValue([]);
      await service.getBackupCodeUsage('user-1');

      expect(auditLogRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', eventType: 'TWO_FA_BACKUP_CODE_USED' },
        }),
      );
    });
  });
});
