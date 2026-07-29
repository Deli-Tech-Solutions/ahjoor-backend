import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { KycProviderParser, ParsedWebhookPayload } from './kyc-provider.interface';
import { KycStatus } from '../entities/kyc-status.enum';

/** Jumio verificationStatus → internal KycStatus */
const STATUS_MAP: Record<string, KycStatus> = {
  approved_verified: KycStatus.APPROVED,
  denied_fraud: KycStatus.REJECTED,
  denied_unsupported_id_type: KycStatus.REJECTED,
  denied_unsupported_id_country: KycStatus.REJECTED,
  error_not_readable_id: KycStatus.NEEDS_REVIEW,
  no_id_uploaded: KycStatus.NEEDS_REVIEW,
};

export class JumioParser implements KycProviderParser {
  validateSignature(rawBody: Buffer, signature: string, secret: string): boolean {
    // Jumio sends a plain base64-encoded HMAC-SHA256 in X-Jumio-Signature
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  parse(rawBody: Buffer): ParsedWebhookPayload {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const providerStatus = String(body['verificationStatus'] ?? '').toLowerCase();
    const userId = String(body['customerId'] ?? '');
    const providerCaseId = String(body['jumioIdScanReference'] ?? '');

    if (!userId) throw new BadRequestException('Jumio payload missing customerId');

    return {
      userId,
      providerCaseId,
      status: STATUS_MAP[providerStatus] ?? KycStatus.NEEDS_REVIEW,
      raw: body,
    };
  }
}
