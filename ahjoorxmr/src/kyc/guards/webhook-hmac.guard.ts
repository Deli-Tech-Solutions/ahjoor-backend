import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { KycProviderFactory } from '../providers/kyc-provider.factory';
import { KycProvider } from '../enums/kyc-provider.enum';

export type KycWebhookRequest = Request & {
  rawBody?: Buffer;
  kycProvider?: KycProvider;
};

/**
 * Maps the signature header a webhook arrives with to the provider that
 * sent it. A case may have failed over to a secondary provider mid-flight
 * (see KycProviderOrchestrator), so the guard cannot assume a single fixed
 * provider — it must detect which provider is calling back and validate
 * (and later parse) using that provider's own scheme.
 */
const HEADER_TO_PROVIDER: Array<{ header: string; provider: KycProvider }> = [
  { header: 'persona-signature', provider: KycProvider.PERSONA },
  { header: 'x-jumio-signature', provider: KycProvider.JUMIO },
  { header: 'x-sha2-signature', provider: KycProvider.ONFIDO },
];

/** Validates the HMAC signature on incoming KYC webhook requests. */
@Injectable()
export class WebhookHmacGuard implements CanActivate {
  private readonly logger = new Logger(WebhookHmacGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly providerFactory: KycProviderFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<KycWebhookRequest>();
    const secret = this.config.get<string>('KYC_WEBHOOK_SECRET');

    if (!secret) {
      this.logger.error('KYC_WEBHOOK_SECRET is not configured');
      throw new UnauthorizedException('Webhook secret not configured');
    }

    // NestJS raw body is available when bodyParser rawBody option is enabled
    const rawBody: Buffer | undefined = req.rawBody;
    if (!rawBody) {
      this.logger.error('Raw body not available – ensure rawBody is enabled in NestFactory');
      throw new UnauthorizedException('Cannot verify signature: raw body unavailable');
    }

    const match = HEADER_TO_PROVIDER.find(({ header }) => req.headers[header]);
    const signature = match ? (req.headers[match.header] as string) : '';
    // x-hub-signature-256 is a generic fallback header some providers reuse;
    // when present without a provider-specific header, defer to the app's
    // configured default provider.
    const fallbackSignature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature && !fallbackSignature) {
      this.logger.warn('Webhook request missing signature header');
      throw new UnauthorizedException('Missing webhook signature');
    }

    const provider = match?.provider;
    const parser = this.providerFactory.getParser(provider);
    const valid = parser.validateSignature(rawBody, signature || fallbackSignature!, secret);

    if (!valid) {
      this.logger.warn('Webhook HMAC validation failed');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    req.kycProvider = provider;

    return true;
  }
}
