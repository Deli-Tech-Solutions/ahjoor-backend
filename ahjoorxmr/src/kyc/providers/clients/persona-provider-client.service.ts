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
 * Outbound client for creating a Persona inquiry.
 * Request/response shape is a best-effort mapping of Persona's "create
 * inquiry" API — validate against real Persona API docs/credentials before
 * relying on this in production.
 */
@Injectable()
export class PersonaProviderClient implements KycProviderClient {
  readonly provider = KycProvider.PERSONA;
  private readonly logger = new Logger(PersonaProviderClient.name);

  constructor(private readonly config: ConfigService) {}

  async submitVerification(
    params: SubmitVerificationParams,
    timeoutMs: number,
  ): Promise<ProviderSubmissionResult> {
    const baseUrl = this.config.get<string>(
      'PERSONA_API_BASE_URL',
      'https://withpersona.com/api/v1',
    );
    const apiKey = this.config.get<string>('PERSONA_API_KEY', '');

    const response = await axios.post(
      `${baseUrl}/inquiries`,
      {
        data: {
          attributes: {
            'reference-id': params.userId,
            'document-url': params.documentUrl,
            'document-set-hash': params.documentSetHash,
          },
        },
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: timeoutMs,
      },
    );

    const data = response.data?.data ?? {};
    const result = {
      providerCaseId: String(data.id ?? ''),
      providerStatus: String(data.attributes?.status ?? 'pending'),
    };
    this.logger.debug(`Persona inquiry created: ${JSON.stringify(result)}`);
    return result;
  }
}
