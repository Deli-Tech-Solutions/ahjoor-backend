import {
  Controller,
  Post,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { KycWebhookService } from './kyc-webhook.service';
import { WebhookHmacGuard, KycWebhookRequest } from './guards/webhook-hmac.guard';

@ApiTags('KYC')
@Controller('kyc')
export class KycWebhookController {
  private readonly logger = new Logger(KycWebhookController.name);

  constructor(private readonly kycWebhookService: KycWebhookService) {}

  @Post('webhook')
  @UseGuards(WebhookHmacGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'KYC provider webhook receiver',
    description:
      'Accepts provider-specific payloads, validates HMAC signature, and updates user KYC status.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid or missing HMAC signature' })
  async handleWebhook(@Req() req: KycWebhookRequest): Promise<{ received: true }> {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    await this.kycWebhookService.processWebhook(rawBody, req.kycProvider);
    return { received: true };
  }
}
