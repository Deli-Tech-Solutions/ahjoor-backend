import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { KycProvider } from '../../enums/kyc-provider.enum';
import {
  KycProviderClient,
  ProviderSubmissionResult,
  SubmitVerificationParams,
} from '../kyc-provider-client.interface';

/**
 * Outbound client for creating a Jumio account/scan reference.
 * Request/response shape is a best-effort mapping of Jumio's "create
 * account" API — validate against real Jumio API docs/credentials before
 * relying on this in production.
 */
@Injectable()
export class JumioProviderClient implements KycProviderClient {
  readonly provider = KycProvider.JUMIO;
  private readonly logger = new Logger(JumioProviderClient.name);

  constructor(private readonly config: ConfigService) {}

  async submitVerification(
    params: SubmitVerificationParams,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult> {
    const baseUrl = this.config.get<string>(
      'JUMIO_API_BASE_URL',
      'https://api.jumio.com/api/v1',
    );
    const apiToken = this.config.get<string>('JUMIO_API_TOKEN', '');

    const response = await axios.post(
      `${baseUrl}/accounts`,
      {
        customerId: params.userId,
        documentUrl: params.documentUrl,
        documentSetHash: params.documentSetHash,
      },
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        timeout: timeoutMs,
      },
    );

    const data = response.data ?? {};
    const result = {
      providerCaseId: String(data.jumioIdScanReference ?? ''),
      providerStatus: String(data.verificationStatus ?? 'pending').toLowerCase(),
    };
    this.logger.debug(`Jumio scan created: ${JSON.stringify(result)}`);
    return result;
  }
}
