import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { WebhookHmacGuard, KycWebhookRequest } from './webhook-hmac.guard';
import { KycProviderFactory } from '../providers/kyc-provider.factory';
import { KycProvider } from '../enums/kyc-provider.enum';

function makeContext(headers: Record<string, string>): ExecutionContext {
  const req: KycWebhookRequest = {
    headers,
    rawBody: Buffer.from('{}'),
  } as unknown as KycWebhookRequest;

  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('WebhookHmacGuard', () => {
  let guard: WebhookHmacGuard;
  let config: { get: jest.Mock };
  let providerFactory: { getParser: jest.Mock };
  let mockParser: { validateSignature: jest.Mock };

  beforeEach(() => {
    mockParser = { validateSignature: jest.fn().mockReturnValue(true) };
    config = { get: jest.fn().mockReturnValue('shared-secret') };
    providerFactory = { getParser: jest.fn().mockReturnValue(mockParser) };
    guard = new WebhookHmacGuard(config as any, providerFactory as any);
  });

  it('detects Persona from the persona-signature header and validates with the Persona parser', () => {
    const context = makeContext({ 'persona-signature': 't=1,v1=abc' });
    expect(guard.canActivate(context)).toBe(true);
    expect(providerFactory.getParser).toHaveBeenCalledWith(KycProvider.PERSONA);
  });

  it('detects Jumio from the x-jumio-signature header and validates with the Jumio parser', () => {
    const context = makeContext({ 'x-jumio-signature': 'base64sig' });
    expect(guard.canActivate(context)).toBe(true);
    expect(providerFactory.getParser).toHaveBeenCalledWith(KycProvider.JUMIO);
  });

  it('detects Onfido from the x-sha2-signature header and validates with the Onfido parser', () => {
    const context = makeContext({ 'x-sha2-signature': 'sha256=hex' });
    expect(guard.canActivate(context)).toBe(true);
    expect(providerFactory.getParser).toHaveBeenCalledWith(KycProvider.ONFIDO);
  });

  it('stashes the detected provider on the request for downstream handlers', () => {
    const req: KycWebhookRequest = {
      headers: { 'x-jumio-signature': 'sig' },
      rawBody: Buffer.from('{}'),
    } as unknown as KycWebhookRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    guard.canActivate(context);

    expect(req.kycProvider).toBe(KycProvider.JUMIO);
  });

  it('falls back to the default provider parser for a generic x-hub-signature-256 header', () => {
    const context = makeContext({ 'x-hub-signature-256': 'sha256=hex' });
    expect(guard.canActivate(context)).toBe(true);
    expect(providerFactory.getParser).toHaveBeenCalledWith(undefined);
  });

  it('throws when no signature header is present', () => {
    const context = makeContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws when the secret is not configured', () => {
    config.get.mockReturnValue(undefined);
    const context = makeContext({ 'persona-signature': 't=1,v1=abc' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws when signature validation fails', () => {
    mockParser.validateSignature.mockReturnValue(false);
    const context = makeContext({ 'persona-signature': 't=1,v1=abc' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
