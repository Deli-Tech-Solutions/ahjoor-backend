/**
 * scripts/encrypt-existing-records.ts
 *
 * One-time script to encrypt plaintext PII columns in existing rows.
 * Run with:
 *   ts-node --project tsconfig.migration.json scripts/encrypt-existing-records.ts
 *
 * Required env vars:
 *   DB_FIELD_ENCRYPTION_KEY  — 64-char hex (32 bytes)
 *   DB_FIELD_ENCRYPTION_KEY_PREVIOUS — optional, for rows already encrypted with old key
 *
 * To ROTATE the encryption key online (zero downtime, resumable, batched,
 * throttled) use scripts/rotate-encryption-keys.ts instead — see
 * docs/runbooks/encryption-key-rotation.md.
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { DataSource } from 'typeorm';
import {
  encrypt,
  decrypt,
  hmacBlindIndex,
} from '../src/common/encryption/field-encryption.transformer';

const BATCH_SIZE = 500;

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'ahjoorxmr',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  synchronize: false,
  logging: false,
});

function isLikelyCiphertext(value: string): boolean {
  // Ciphertext is base64 and at minimum IV(12)+TAG(16)+1 byte = 29 bytes → ~40 base64 chars
  if (value.length < 40) return false;
  try {
    const buf = Buffer.from(value, 'base64');
    // Re-encoding should be identical for valid base64
    return buf.toString('base64') === value;
  } catch {
    return false;
  }
}

async function encryptUsers(qr: any): Promise<void> {
  let offset = 0;
  let totalProcessed = 0;

  console.log('[users] Starting encryption pass...');

  while (true) {
    const rows: Array<{ id: string; email: string | null; twoFactorSecret: string | null }> =
      await qr.query(
        `SELECT id, email, "twoFactorSecret" FROM users LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      );

    if (rows.length === 0) break;

    for (const row of rows) {
      const updates: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      if (row.email && !isLikelyCiphertext(row.email)) {
        const ciphertext = encrypt(row.email);
        const blindIndex = hmacBlindIndex(row.email);
        updates.push(`email = $${paramIdx++}`, `"emailBlindIndex" = $${paramIdx++}`);
        params.push(ciphertext, blindIndex);
      } else if (row.email && isLikelyCiphertext(row.email) && !row['emailBlindIndex']) {
        // Already encrypted but missing blind index — compute from decrypted value
        try {
          const plain = decrypt(row.email);
          const blindIndex = hmacBlindIndex(plain);
          updates.push(`"emailBlindIndex" = $${paramIdx++}`);
          params.push(blindIndex);
        } catch {
          console.warn(`[users] Could not decrypt email for user ${row.id}, skipping blind index`);
        }
      }

      if (row.twoFactorSecret && !isLikelyCiphertext(row.twoFactorSecret)) {
        updates.push(`"twoFactorSecret" = $${paramIdx++}`);
        params.push(encrypt(row.twoFactorSecret));
      }

      if (updates.length > 0) {
        params.push(row.id);
        await qr.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
          params,
        );
        totalProcessed++;
      }
    }

    console.log(`[users] Processed batch offset=${offset}, rows=${rows.length}, updated=${totalProcessed}`);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[users] Done. Total rows updated: ${totalProcessed}`);
}

async function encryptKycDocuments(qr: any): Promise<void> {
  let offset = 0;
  let totalProcessed = 0;

  console.log('[kyc_documents] Starting encryption pass...');

  while (true) {
    const rows: Array<{ id: string; documentNumber: string | null }> =
      await qr.query(
        `SELECT id, "documentNumber" FROM kyc_documents WHERE "documentNumber" IS NOT NULL LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      );

    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.documentNumber && !isLikelyCiphertext(row.documentNumber)) {
        await qr.query(
          `UPDATE kyc_documents SET "documentNumber" = $1 WHERE id = $2`,
          [encrypt(row.documentNumber), row.id],
        );
        totalProcessed++;
      }
    }

    console.log(`[kyc_documents] Processed batch offset=${offset}, rows=${rows.length}, updated=${totalProcessed}`);
    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[kyc_documents] Done. Total rows updated: ${totalProcessed}`);
}

async function main(): Promise<void> {
  if (!process.env.DB_FIELD_ENCRYPTION_KEY) {
    console.error('ERROR: DB_FIELD_ENCRYPTION_KEY is not set');
    process.exit(1);
  }

  await dataSource.initialize();
  console.log('Database connected');

  const qr = dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  try {
    await encryptUsers(qr);
    await encryptKycDocuments(qr);
    await qr.commitTransaction();
    console.log('All records encrypted successfully.');
  } catch (err) {
    await qr.rollbackTransaction();
    console.error('Encryption failed, transaction rolled back:', err);
    process.exit(1);
  } finally {
    await qr.release();
    await dataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
