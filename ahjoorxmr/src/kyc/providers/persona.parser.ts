import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { KycProviderParser, ParsedWebhookPayload } from './kyc-provider.interface';
import { KycStatus } from '../entities/kyc-status.enum';

/** Persona status → internal KycStatus */
const STATUS_MAP: Record<string, KycStatus> = {
  approved: KycStatus.APPROVED,
  completed: KycStatus.APPROVED,
  declined: KycStatus.REJECTED,
  failed: KycStatus.REJECTED,
  needs_review: KycStatus.NEEDS_REVIEW,
  created: KycStatus.PENDING,
  pending: KycStatus.PENDING,
};

export class PersonaParser implements KycProviderParser {
  validateSignature(rawBody: Buffer, signature: string, secret: string): boolean {
    // Persona sends: t=<timestamp>,v1=<hmac>
    const parts = Object.fromEntries(
      signature.split(',').map((p) => p.split('=')),
    ) as Record<string, string>;

    if (!parts['t'] || !parts['v1']) return false;

    const signedPayload = `${parts['t']}.${rawBody.toString('utf8')}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(parts['v1']), Buffer.from(expected));
  }

  parse(rawBody: Buffer): ParsedWebhookPayload {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const data = (body['data'] ?? {}) as Record<string, unknown>;
    const attributes = (data['attributes'] ?? {}) as Record<string, unknown>;
    const providerStatus = String(attributes['status'] ?? '').toLowerCase();
    const userId = String(
      (attributes['reference-id'] as string | undefined) ?? '',
    );
    const providerCaseId = String(data['id'] ?? '');

    if (!userId) throw new BadRequestException('Persona payload missing reference-id');

    return {
      userId,
      providerCaseId,
      status: STATUS_MAP[providerStatus] ?? KycStatus.NEEDS_REVIEW,
      raw: body,
    };
  }
}
