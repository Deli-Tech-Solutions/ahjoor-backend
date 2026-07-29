import * as crypto from 'crypto';
import { PersonaParser } from './persona.parser';
import { KycStatus } from '../entities/kyc-status.enum';

const SECRET = 'test-secret';

function makeSignature(body: string, secret: string): string {
  const t = '1700000000';
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');
  return `t=${t},v1=${hmac}`;
}

describe('PersonaParser', () => {
  let parser: PersonaParser;

  beforeEach(() => {
    parser = new PersonaParser();
  });

  describe('validateSignature', () => {
    it('returns true for a valid signature', () => {
      const body = '{"data":{"id":"inq_123","attributes":{"status":"approved","reference-id":"user-uuid"}}}';
      const sig = makeSignature(body, SECRET);
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(true);
    });

    it('returns false for a tampered body', () => {
      const body = '{"data":{"id":"inq_123","attributes":{"status":"approved","reference-id":"user-uuid"}}}';
      const sig = makeSignature(body, SECRET);
      const tampered = body.replace('approved', 'declined');
      expect(parser.validateSignature(Buffer.from(tampered), sig, SECRET)).toBe(false);
    });

    it('returns false for wrong secret', () => {
      const body = '{"data":{"id":"inq_123","attributes":{"status":"approved","reference-id":"user-uuid"}}}';
      const sig = makeSignature(body, 'wrong-secret');
      expect(parser.validateSignature(Buffer.from(body), sig, SECRET)).toBe(false);
    });

    it('returns false for missing signature parts', () => {
      expect(parser.validateSignature(Buffer.from('{}'), 'invalid', SECRET)).toBe(false);
    });
  });

  describe('parse', () => {
    it('maps approved → KycStatus.APPROVED', () => {
      const body = JSON.stringify({
        data: { id: 'inq_abc', attributes: { status: 'approved', 'reference-id': 'user-1' } },
      });
      const result = parser.parse(Buffer.from(body));
      expect(result.status).toBe(KycStatus.APPROVED);
      expect(result.userId).toBe('user-1');
      expect(result.providerCaseId).toBe('inq_abc');
    });

    it('maps declined → KycStatus.REJECTED', () => {
      const body = JSON.stringify({
        data: { id: 'inq_abc', attributes: { status: 'declined', 'reference-id': 'user-1' } },
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.REJECTED);
    });

    it('maps needs_review → KycStatus.NEEDS_REVIEW', () => {
      const body = JSON.stringify({
        data: { id: 'inq_abc', attributes: { status: 'needs_review', 'reference-id': 'user-1' } },
      });
      expect(parser.parse(Buffer.from(body)).status).toBe(KycStatus.NEEDS_REVIEW);
    });

    it('throws BadRequestException when reference-id is missing', () => {
      const body = JSON.stringify({
        data: { id: 'inq_abc', attributes: { status: 'approved' } },
      });
      expect(() => parser.parse(Buffer.from(body))).toThrow();
    });
  });
});
