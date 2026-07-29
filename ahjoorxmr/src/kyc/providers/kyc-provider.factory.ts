import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycProvider } from '../enums/kyc-provider.enum';
import { KycProviderParser } from './kyc-provider.interface';
import { PersonaParser } from './persona.parser';
import { JumioParser } from './jumio.parser';
import { OnfidoParser } from './onfido.parser';

@Injectable()
export class KycProviderFactory {
  private readonly parser: KycProviderParser;

  constructor(private readonly config: ConfigService) {
    const provider = this.config.get<string>('KYC_PROVIDER', KycProvider.PERSONA);
    this.parser = KycProviderFactory.createParser(provider as KycProvider);
  }

  /**
   * Returns the parser for a specific provider (needed when a case has
   * failed over to a secondary provider, whose callback must be parsed with
   * its own signature scheme/payload shape). Falls back to the app's
   * configured default provider when none is given.
   */
  getParser(provider?: KycProvider): KycProviderParser {
    if (!provider) {
      return this.parser;
    }
    return KycProviderFactory.createParser(provider);
  }

  static createParser(provider: KycProvider): KycProviderParser {
    switch (provider) {
      case KycProvider.JUMIO:
        return new JumioParser();
      case KycProvider.ONFIDO:
        return new OnfidoParser();
      case KycProvider.PERSONA:
      default:
        return new PersonaParser();
    }
  }
}
