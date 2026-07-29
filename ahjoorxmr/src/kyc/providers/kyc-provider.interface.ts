import { KycStatus } from '../entities/kyc-status.enum';

export interface ParsedWebhookPayload {
  /** Internal user ID extracted from the payload */
  userId: string;
  /** Provider's own case/reference ID for this verification */
  providerCaseId: string;
  /** Normalised status mapped to our internal enum */
  status: KycStatus;
  /** Raw payload for audit storage */
  raw: Record<string, unknown>;
}

export interface KycProviderParser {
  /**
   * Validate the HMAC signature of the incoming request.
   * @param rawBody  Raw request body buffer
   * @param signature  Signature header value from the provider
   * @param secret  Shared webhook secret
   */
  validateSignature(rawBody: Buffer, signature: string, secret: string): boolean;

  /**
   * Parse the raw body into a normalised payload.
   */
  parse(rawBody: Buffer): ParsedWebhookPayload;
}
