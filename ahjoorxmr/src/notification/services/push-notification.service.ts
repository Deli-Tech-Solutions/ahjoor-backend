import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { DeviceToken, DevicePlatform } from '../entities/device-token.entity';

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushNotificationResult {
  success: boolean;
  token: string;
  error?: string;
}

/**
 * Service for sending push notifications via Firebase Cloud Messaging (FCM)
 * and Apple Push Notification service (APNs).
 */
@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private firebaseApp: admin.app.App | null = null;

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepo: Repository<DeviceToken>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Initialize Firebase Admin SDK on module init
   */
  onModuleInit(): void {
    const firebaseProjectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const firebaseClientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const firebasePrivateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (!firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey) {
      this.logger.warn('Firebase configuration missing. Push notifications will be disabled.');
      return;
    }

    try {
      // Check if Firebase app is already initialized
      if (admin.apps.length > 0) {
        this.firebaseApp = admin.apps[0]!;
        this.logger.log('Firebase Admin SDK already initialized');
      } else {
        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId: firebaseProjectId,
            clientEmail: firebaseClientEmail,
            privateKey: firebasePrivateKey.replace(/\\n/g, '\n'),
          }),
        });
        this.logger.log('Firebase Admin SDK initialized successfully');
      }
    } catch (error) {
      this.logger.error('Failed to initialize Firebase Admin SDK:', error);
    }
  }

  /**
   * Send push notification to all active device tokens for a user
   */
  async sendPush(
    userId: string,
    payload: PushNotificationPayload,
  ): Promise<PushNotificationResult[]> {
    if (!this.firebaseApp) {
      this.logger.warn('Firebase not initialized. Cannot send push notification.');
      return [];
    }

    // Get all active device tokens for the user
    const deviceTokens = await this.deviceTokenRepo.find({
      where: { userId, isActive: true },
    });

    if (deviceTokens.length === 0) {
      this.logger.debug(`No active device tokens found for user ${userId}`);
      return [];
    }

    const results: PushNotificationResult[] = [];

    for (const deviceToken of deviceTokens) {
      try {
        const result = await this.sendToToken(deviceToken.token, payload);
        results.push(result);

        if (result.success) {
          // Update lastUsedAt timestamp
          await this.deviceTokenRepo.update(deviceToken.id, {
            lastUsedAt: new Date(),
          });
        } else {
          // Mark token as inactive if delivery failed (e.g., token is invalid)
          if (this.isInvalidTokenError(result.error)) {
            await this.deactivateToken(deviceToken.id);
            this.logger.warn(`Deactivated invalid token for user ${userId}: ${deviceToken.token}`);
          }
        }
      } catch (error) {
        this.logger.error(`Failed to send push to token ${deviceToken.token}:`, error);
        results.push({
          success: false,
          token: deviceToken.token,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    this.logger.log(`Push notification sent to ${successCount}/${results.length} devices for user ${userId}`);

    return results;
  }

  /**
   * Send push notification to a specific token
   */
  private async sendToToken(
    token: string,
    payload: PushNotificationPayload,
  ): Promise<PushNotificationResult> {
    if (!this.firebaseApp) {
      return { success: false, token, error: 'Firebase not initialized' };
    }

    try {
      const message: admin.messaging.Message = {
        token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'default',
            priority: 'high',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: payload.title,
                body: payload.body,
              },
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      this.logger.debug(`Push sent successfully: ${response}`);

      return { success: true, token };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send push to token ${token}:`, error);

      return { success: false, token, error: errorMessage };
    }
  }

  /**
   * Register a new device token for a user
   */
  async registerToken(
    userId: string,
    token: string,
    platform: DevicePlatform,
    deviceId?: string,
    deviceName?: string,
    appVersion?: string,
  ): Promise<DeviceToken> {
    // Check if token already exists
    const existingToken = await this.deviceTokenRepo.findOne({
      where: { token },
    });

    if (existingToken) {
      // Update existing token with new user info and mark as active
      existingToken.userId = userId;
      existingToken.platform = platform;
      existingToken.deviceId = deviceId;
      existingToken.deviceName = deviceName;
      existingToken.appVersion = appVersion;
      existingToken.isActive = true;
      existingToken.lastUsedAt = new Date();

      return this.deviceTokenRepo.save(existingToken);
    }

    // Create new token
    const deviceToken = this.deviceTokenRepo.create({
      userId,
      token,
      platform,
      deviceId,
      deviceName,
      appVersion,
      isActive: true,
      lastUsedAt: new Date(),
    });

    return this.deviceTokenRepo.save(deviceToken);
  }

  /**
   * Unregister (deactivate) a device token
   */
  async unregisterToken(userId: string, token: string): Promise<boolean> {
    const deviceToken = await this.deviceTokenRepo.findOne({
      where: { token, userId },
    });

    if (!deviceToken) {
      return false;
    }

    await this.deviceTokenRepo.update(deviceToken.id, { isActive: false });
    return true;
  }

  /**
   * Get all active device tokens for a user
   */
  async getUserTokens(userId: string): Promise<DeviceToken[]> {
    return this.deviceTokenRepo.find({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Deactivate a token by ID
   */
  private async deactivateToken(tokenId: string): Promise<void> {
    await this.deviceTokenRepo.update(tokenId, { isActive: false });
  }

  /**
   * Check if error indicates an invalid token
   */
  private isInvalidTokenError(error?: string): boolean {
    if (!error) return false;
    const invalidTokenErrors = [
      'registration-token-not-registered',
      'invalid-registration-token',
      'The registration token is not a valid FCM registration token',
      'Requested entity was not found',
    ];
    return invalidTokenErrors.some((err) => error.includes(err));
  }
}
