import * as crypto from 'crypto';
import { OnfidoParser } from './onfido.parser';
import { KycStatus } from '../entities/kyc-status.enum';

const SECRET = 'test-secret';

function makeSignature(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

describe('OnfidoParser', () => {
  let parser: OnfidoParser;

  beforeEach(() => {
    parser = new OnfidoParser();
  });

  describe('validateSignature', () => {
    it('returns true for a valid sha256= prefixed signature', () => {
      const body = '{"payload":{"action":"check.completed","object":{"id":"app-1","result":"clear"}}}';
      const sig = makeSignature(body, SECRET);
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(true);
    });

    it('returns true for a signature without sha256= prefix', () => {
      const body = '{"payload":{"action":"check.completed","object":{"id":"app-1","result":"clear"}}}';
      const raw = crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
      expect(parser.validateSignature(Buffer.from(body), raw, SECRET)).toBe(true);
    });

    it('returns false for wrong secret', () => {
      const body = '{"payload":{"action":"check.completed","object":{"id":"app-1","result":"clear"}}}';
      const sig = makeSignature(body, 'wrong');
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(false);
    });
  });

  describe('parse', () => {
    it('maps clear → KycStatus.APPROVED', () => {
      const body = JSON.stringify({
        payload: { action: 'check.completed', object: { id: 'check-1', applicant_id: 'app-1', result: 'clear' } },
      });
      const result = parser.parse(Buffer.from(body));
      expect(result.status).toBe(KycStatus.APPROVED);
      expect(result.providerCaseId).toBe('check-1');
      expect(result.userId).toBe('app-1');
    });

    it('maps consider → KycStatus.NEEDS_REVIEW', () => {
      const body = JSON.stringify({
        payload: { action: 'check.completed', object: { id: 'check-1', applicant_id: 'app-1', result: 'consider' } },
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.NEEDS_REVIEW);
    });

    it('maps rejected → KycStatus.REJECTED', () => {
      const body = JSON.stringify({
        payload: { action: 'check.completed', object: { id: 'check-1', applicant_id: 'app-1', result: 'rejected' } },
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.REJECTED);
    });
  });
});
