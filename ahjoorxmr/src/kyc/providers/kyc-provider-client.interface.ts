import { KycProvider } from '../enums/kyc-provider.enum';

/**
 * Outbound submission — starts a verification case with a provider.
 * Distinct from KycProviderParser (kyc-provider.interface.ts), which only
 * parses inbound webhook callbacks.
 */
export interface SubmitVerificationParams {
  userId: string;
  documentId: string;
  documentUrl: string;
  documentSetHash: string;
}

export interface ProviderSubmissionResult {
  providerCaseId: string;
  providerStatus: string;
}

export interface KycProviderClient {
  readonly provider: KycProvider;

  /**
   * Submit a verification case to the provider. Must reject once `timeoutMs`
   * elapses so the orchestrator can fail over to a secondary provider.
   */
  submitVerification(
    params: SubmitVerificationParams,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult>;
}
