import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import * as path from 'path';
import { Notification } from './notification.entity';
import { NotificationPreference } from './notification-preference.entity';
import { DeviceToken } from './entities/device-token.entity';
import { NotificationsService } from './notifications.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationsController } from './notifications.controller';
import { SseAdminController } from './sse-admin.controller';
import { NotificationsGateway } from './notifications.gateway';
import {
  NotificationPreferenceController,
  AdminNotificationPreferenceController,
} from './notification-preference.controller';
import { DeviceTokenController } from './device-token.controller';
import { PushNotificationService } from './services/push-notification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, NotificationPreference, DeviceToken]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_ACCESS_SECRET') || 'default_access_secret',
      }),
      inject: [ConfigService],
    }),
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        transport: {
          host: config.get<string>('SMTP_HOST'),
          port: config.get<number>('SMTP_PORT', 587),
          secure: config.get<number>('SMTP_PORT', 587) === 465,
          auth: {
            user: config.get<string>('SMTP_USER'),
            pass: config.get<string>('SMTP_PASS'),
          },
        },
        defaults: {
          from: config.get<string>('MAIL_FROM', '"App" <no-reply@app.com>'),
        },
        template: {
          dir: path.join(__dirname, 'templates'),
          adapter: new HandlebarsAdapter(),
          options: { strict: true },
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [
    NotificationsController,
    SseAdminController,
    NotificationPreferenceController,
    AdminNotificationPreferenceController,
    DeviceTokenController,
  ],
  providers: [
    NotificationsService,
    NotificationsController,
    NotificationsGateway,
    NotificationPreferenceService,
    PushNotificationService,
  ],
  exports: [NotificationsService, NotificationsGateway, NotificationPreferenceService, PushNotificationService],
})
export class NotificationsModule {}
