import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { KycProviderParser, ParsedWebhookPayload } from './kyc-provider.interface';
import { KycStatus } from '../entities/kyc-status.enum';

/** Onfido result → internal KycStatus */
const STATUS_MAP: Record<string, KycStatus> = {
  clear: KycStatus.APPROVED,
  consider: KycStatus.NEEDS_REVIEW,
  unidentified: KycStatus.NEEDS_REVIEW,
  caution: KycStatus.NEEDS_REVIEW,
  rejected: KycStatus.REJECTED,
};

export class OnfidoParser implements KycProviderParser {
  validateSignature(rawBody: Buffer, signature: string, secret: string): boolean {
    // Onfido sends: sha256=<hex_digest>
    const sigValue = signature.startsWith('sha256=')
      ? signature.slice(7)
      : signature;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(sigValue),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  parse(rawBody: Buffer): ParsedWebhookPayload {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const payload = (body['payload'] ?? {}) as Record<string, unknown>;
    const object = (payload['object'] ?? {}) as Record<string, unknown>;
    const providerStatus = String(object['result'] ?? payload['action'] ?? '').toLowerCase();
    // applicant_id is present on check/report objects; fall back to object id for applicant events
    const userId = String(
      object['applicant_id'] ?? (payload['resource_type'] === 'applicant' ? object['id'] : '') ?? '',
    );
    const providerCaseId = String(object['id'] ?? '');

    if (!userId) throw new BadRequestException('Onfido payload missing applicant id');

    return {
      userId,
      providerCaseId,
      status: STATUS_MAP[providerStatus] ?? KycStatus.NEEDS_REVIEW,
      raw: body,
    };
  }
}
