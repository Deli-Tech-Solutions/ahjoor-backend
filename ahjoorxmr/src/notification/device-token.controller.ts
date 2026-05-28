import {
  Controller,
  Post,
  Delete,
  Body,
  Request,
  UseGuards,
  Version,
  HttpCode,
  HttpStatus,
  Get,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PushNotificationService } from './services/push-notification.service';
import {
  RegisterDeviceTokenDto,
  UnregisterDeviceTokenDto,
  DeviceTokenResponseDto,
} from './dto/device-token.dto';
import { DeviceToken } from './entities/device-token.entity';

/**
 * Controller for managing device tokens for push notifications.
 * Provides endpoints for registering and unregistering device tokens.
 */
@ApiTags('Device Tokens')
@Controller('users/me/device-tokens')
@UseGuards(JwtAuthGuard)
export class DeviceTokenController {
  constructor(private readonly pushNotificationService: PushNotificationService) {}

  /**
   * Register a new device token for push notifications
   */
  @Post()
  @Version('1')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Register a device token for push notifications',
    description: 'Registers a device token (FCM or APNs) to receive push notifications for the authenticated user.',
  })
  @ApiResponse({
    status: 201,
    description: 'Device token registered successfully',
    type: DeviceTokenResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request data',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  async registerToken(
    @Request() req: { user: { id: string } },
    @Body() dto: RegisterDeviceTokenDto,
  ): Promise<DeviceTokenResponseDto> {
    const deviceToken = await this.pushNotificationService.registerToken(
      req.user.id,
      dto.token,
      dto.platform ?? 'fcm' as any,
      dto.deviceId,
      dto.deviceName,
      dto.appVersion,
    );

    return this.mapToResponseDto(deviceToken);
  }

  /**
   * Unregister a device token
   */
  @Delete()
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Unregister a device token',
    description: 'Deactivates a device token to stop receiving push notifications.',
  })
  @ApiResponse({
    status: 204,
    description: 'Device token unregistered successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request data',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  @ApiResponse({
    status: 404,
    description: 'Token not found for this user',
  })
  async unregisterToken(
    @Request() req: { user: { id: string } },
    @Body() dto: UnregisterDeviceTokenDto,
  ): Promise<void> {
    const success = await this.pushNotificationService.unregisterToken(req.user.id, dto.token);

    if (!success) {
      // Return 204 even if not found to avoid token enumeration attacks
      return;
    }
  }

  /**
   * List all device tokens for the authenticated user
   */
  @Get()
  @Version('1')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List device tokens',
    description: 'Returns all active device tokens registered for the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Device tokens retrieved successfully',
    type: [DeviceTokenResponseDto],
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized',
  })
  async listTokens(
    @Request() req: { user: { id: string } },
  ): Promise<DeviceTokenResponseDto[]> {
    const tokens = await this.pushNotificationService.getUserTokens(req.user.id);
    return tokens.map((token) => this.mapToResponseDto(token));
  }

  /**
   * Map DeviceToken entity to response DTO
   */
  private mapToResponseDto(token: DeviceToken): DeviceTokenResponseDto {
    return {
      id: token.id,
      token: token.token,
      platform: token.platform,
      deviceId: token.deviceId,
      deviceName: token.deviceName,
      appVersion: token.appVersion,
      isActive: token.isActive,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
  }
}
