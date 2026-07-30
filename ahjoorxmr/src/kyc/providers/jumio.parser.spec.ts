import * as crypto from 'crypto';
import { JumioParser } from './jumio.parser';
import { KycStatus } from '../entities/kyc-status.enum';

const SECRET = 'test-secret';

function makeSignature(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('base64');
}

describe('JumioParser', () => {
  let parser: JumioParser;

  beforeEach(() => {
    parser = new JumioParser();
  });

  describe('validateSignature', () => {
    it('returns true for a valid signature', () => {
      const body = '{"verificationStatus":"APPROVED_VERIFIED","customerId":"user-1","jumioIdScanReference":"ref-1"}';
      const sig = makeSignature(body, SECRET);
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(true);
    });

    it('returns false for wrong secret', () => {
      const body = '{"verificationStatus":"APPROVED_VERIFIED","customerId":"user-1","jumioIdScanReference":"ref-1"}';
      const sig = makeSignature(body, 'wrong');
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(false);
    });
  });

  describe('parse', () => {
    it('maps APPROVED_VERIFIED → KycStatus.APPROVED', () => {
      const body = JSON.stringify({
        verificationStatus: 'APPROVED_VERIFIED',
        customerId: 'user-1',
        jumioIdScanReference: 'ref-1',
      });
      const result = parser.parse(Buffer.from(body));
      expect(result.status).toBe(KycStatus.APPROVED);
      expect(result.userId).toBe('user-1');
      expect(result.providerCaseId).toBe('ref-1');
    });

    it('maps DENIED_FRAUD → KycStatus.REJECTED', () => {
      const body = JSON.stringify({
        verificationStatus: 'DENIED_FRAUD',
        customerId: 'user-1',
        jumioIdScanReference: 'ref-1',
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.REJECTED);
    });

    it('maps ERROR_NOT_READABLE_ID → KycStatus.NEEDS_REVIEW', () => {
      const body = JSON.stringify({
        verificationStatus: 'ERROR_NOT_READABLE_ID',
        customerId: 'user-1',
        jumioIdScanReference: 'ref-1',
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.NEEDS_REVIEW);
    });

    it('throws when customerId is missing', () => {
      const body = JSON.stringify({ verificationStatus: 'APPROVED_VERIFIED', jumioIdScanReference: 'ref-1' });
      expect(() => parser.parse(Buffer.from(body))).toThrow();
    });
  });
});
