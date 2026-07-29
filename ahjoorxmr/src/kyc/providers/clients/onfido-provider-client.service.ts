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
 * Outbound client for creating an Onfido check.
 * Request/response shape is a best-effort mapping of Onfido's "create
 * check" API — validate against real Onfido API docs/credentials before
 * relying on this in production.
 */
@Injectable()
export class OnfidoProviderClient implements KycProviderClient {
  readonly provider = KycProvider.ONFIDO;
  private readonly logger = new Logger(OnfidoProviderClient.name);

  constructor(private readonly config: ConfigService) {}

  async submitVerification(
    params: SubmitVerificationParams,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult> {
    const baseUrl = this.config.get<string>(
      'ONFIDO_API_BASE_URL',
      'https://api.onfido.com/v3.6',
    );
    const apiToken = this.config.get<string>('ONFIDO_API_TOKEN', '');

    const response = await axios.post(
      `${baseUrl}/checks`,
      {
        applicant_id: params.userId,
        document_url: params.documentUrl,
        document_set_hash: params.documentSetHash,
      },
      {
        headers: { Authorization: `Token token=${apiToken}` },
        timeout: timeoutMs,
      },
    );

    const data = response.data ?? {};
    const result = {
      providerCaseId: String(data.id ?? ''),
      providerStatus: String(data.status ?? 'in_progress'),
    };
    this.logger.debug(`Onfido check created: ${JSON.stringify(result)}`);
    return result;
  }
}
