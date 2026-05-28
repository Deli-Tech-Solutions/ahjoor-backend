import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PushNotificationService } from '../push-notification.service';
import { DeviceToken, DevicePlatform } from '../../entities/device-token.entity';

describe('PushNotificationService', () => {
  let service: PushNotificationService;
  let deviceTokenRepo: jest.Mocked<Repository<DeviceToken>>;

  const mockDeviceToken = (overrides: Partial<DeviceToken> = {}): DeviceToken => ({
    id: 'token-1',
    userId: 'user-1',
    token: 'fcm_token_abc123',
    platform: DevicePlatform.FCM,
    deviceId: 'device-1',
    deviceName: 'Test Device',
    appVersion: '1.0.0',
    isActive: true,
    lastUsedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    user: null as any,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushNotificationService,
        {
          provide: getRepositoryToken(DeviceToken),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            save: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'FIREBASE_PROJECT_ID') return 'test-project';
              if (key === 'FIREBASE_CLIENT_EMAIL') return 'test@test.com';
              if (key === 'FIREBASE_PRIVATE_KEY') return '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PushNotificationService>(PushNotificationService);
    deviceTokenRepo = module.get(getRepositoryToken(DeviceToken));
  });

  describe('registerToken', () => {
    it('should create a new device token if token does not exist', async () => {
      const userId = 'user-1';
      const token = 'new_token_123';
      const platform = DevicePlatform.FCM;
      const deviceId = 'device-1';
      const deviceName = 'iPhone 15';
      const appVersion = '1.2.3';

      deviceTokenRepo.findOne.mockResolvedValue(null);
      deviceTokenRepo.create.mockReturnValue(mockDeviceToken({ userId, token, platform }));
      deviceTokenRepo.save.mockResolvedValue(mockDeviceToken({ userId, token, platform }));

      const result = await service.registerToken(userId, token, platform, deviceId, deviceName, appVersion);

      expect(deviceTokenRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        token,
        platform,
        deviceId,
        deviceName,
        appVersion,
        isActive: true,
      }));
      expect(deviceTokenRepo.save).toHaveBeenCalled();
      expect(result.token).toBe(token);
    });

    it('should update existing token if token already exists', async () => {
      const existingToken = mockDeviceToken({ id: 'existing-id' });
      deviceTokenRepo.findOne.mockResolvedValue(existingToken);
      deviceTokenRepo.save.mockResolvedValue({ ...existingToken, userId: 'new-user' });

      await service.registerToken('new-user', existingToken.token, DevicePlatform.APN);

      expect(deviceTokenRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'existing-id',
        userId: 'new-user',
        isActive: true,
      }));
    });
  });

  describe('unregisterToken', () => {
    it('should deactivate token when found', async () => {
      const token = mockDeviceToken();
      deviceTokenRepo.findOne.mockResolvedValue(token);
      deviceTokenRepo.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      const result = await service.unregisterToken(token.userId, token.token);

      expect(result).toBe(true);
      expect(deviceTokenRepo.update).toHaveBeenCalledWith(token.id, { isActive: false });
    });

    it('should return false when token not found', async () => {
      deviceTokenRepo.findOne.mockResolvedValue(null);

      const result = await service.unregisterToken('user-1', 'nonexistent_token');

      expect(result).toBe(false);
    });
  });

  describe('getUserTokens', () => {
    it('should return all active tokens for user', async () => {
      const tokens = [mockDeviceToken(), mockDeviceToken({ id: 'token-2' })];
      deviceTokenRepo.find.mockResolvedValue(tokens);

      const result = await service.getUserTokens('user-1');

      expect(result).toHaveLength(2);
      expect(deviceTokenRepo.find).toHaveBeenCalledWith({
        where: { userId: 'user-1', isActive: true },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('sendPush', () => {
    it('should return empty array when Firebase is not initialized', async () => {
      // Create service without Firebase config
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PushNotificationService,
          {
            provide: getRepositoryToken(DeviceToken),
            useValue: deviceTokenRepo,
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => undefined), // No Firebase config
            },
          },
        ],
      }).compile();

      const serviceWithoutFirebase = module.get<PushNotificationService>(PushNotificationService);
      const result = await serviceWithoutFirebase.sendPush('user-1', { title: 'Test', body: 'Test' });

      expect(result).toEqual([]);
    });

    it('should return empty array when no active tokens found', async () => {
      deviceTokenRepo.find.mockResolvedValue([]);

      const result = await service.sendPush('user-1', { title: 'Test', body: 'Test' });

      expect(result).toEqual([]);
    });
  });
});
