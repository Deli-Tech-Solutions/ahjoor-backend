import { IsString, IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DevicePlatform } from '../entities/device-token.entity';

/**
 * DTO for registering a device token for push notifications
 */
export class RegisterDeviceTokenDto {
  @ApiProperty({
    description: 'The push notification token (FCM or APNs)',
    example: 'fcm_token_abc123',
  })
  @IsString()
  token: string;

  @ApiProperty({
    description: 'The device platform',
    enum: DevicePlatform,
    example: DevicePlatform.FCM,
    default: DevicePlatform.FCM,
  })
  @IsEnum(DevicePlatform)
  @IsOptional()
  platform?: DevicePlatform = DevicePlatform.FCM;

  @ApiProperty({
    description: 'Unique device identifier',
    example: 'device_abc123',
    required: false,
  })
  @IsString()
  @IsOptional()
  deviceId?: string;

  @ApiProperty({
    description: 'Human-readable device name',
    example: 'iPhone 15 Pro',
    required: false,
  })
  @IsString()
  @IsOptional()
  deviceName?: string;

  @ApiProperty({
    description: 'App version',
    example: '1.2.3',
    required: false,
  })
  @IsString()
  @IsOptional()
  appVersion?: string;
}

/**
 * DTO for unregistering a device token
 */
export class UnregisterDeviceTokenDto {
  @ApiProperty({
    description: 'The push notification token to unregister',
    example: 'fcm_token_abc123',
  })
  @IsString()
  token: string;
}

/**
 * Response DTO for device token operations
 */
export class DeviceTokenResponseDto {
  @ApiProperty({ description: 'Device token ID' })
  id: string;

  @ApiProperty({ description: 'The push notification token' })
  token: string;

  @ApiProperty({ enum: DevicePlatform, description: 'Device platform' })
  platform: DevicePlatform;

  @ApiProperty({ description: 'Device identifier', required: false, nullable: true })
  deviceId?: string;

  @ApiProperty({ description: 'Device name', required: false, nullable: true })
  deviceName?: string;

  @ApiProperty({ description: 'App version', required: false, nullable: true })
  appVersion?: string;

  @ApiProperty({ description: 'Whether the token is active' })
  isActive: boolean;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}

/**
 * DTO for sending a push notification
 */
export class SendPushNotificationDto {
  @ApiProperty({
    description: 'Target user ID',
    example: 'user_uuid_123',
  })
  @IsString()
  userId: string;

  @ApiProperty({
    description: 'Notification title',
    example: 'Round Deadline Approaching',
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Notification body',
    example: 'Your contribution is due in 24 hours',
  })
  @IsString()
  body: string;

  @ApiProperty({
    description: 'Additional data payload',
    example: { groupId: 'group_123', round: 5 },
    required: false,
  })
  @IsOptional()
  data?: Record<string, any>;
}
