/**
 * scripts/rotate-encryption-keys.ts
 *
 * Online, resumable, throttled re-encryption of PII columns for encryption key
 * rotation. Safe to run against a live database and safe to interrupt — rerun
 * it and it continues from the last committed batch.
 *
 * Run with:
 *   ts-node --project tsconfig.migration.json scripts/rotate-encryption-keys.ts
 *
 * Required env vars (versioned encryption must be enabled):
 *   DB_FIELD_ENCRYPTION_KEY                  — NEW active key (64-char hex)
 *   DB_FIELD_ENCRYPTION_KEY_VERSION          — NEW active key version, e.g. 2
 *   DB_FIELD_ENCRYPTION_KEY_PREVIOUS         — OLD key (64-char hex)
 *   DB_FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION — OLD key version, e.g. 1 (optional,
 *                                             defaults to VERSION - 1)
 *
 * Optional tuning:
 *   ROTATION_BATCH_SIZE   — rows per batch (default 500)
 *   ROTATION_THROTTLE_MS  — pause between batches in ms (default 100)
 *   ROTATION_MAX_FAILURES — undecryptable rows tolerated before abort (default 0)
 *   ROTATION_TABLES       — comma list to restrict, e.g. "users,kyc_documents"
 *
 * See docs/runbooks/encryption-key-rotation.md for the full procedure.
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { DataSource } from 'typeorm';
import {
  getActiveKeyVersion,
  isVersionedEncryptionEnabled,
} from '../src/common/encryption/field-encryption.transformer';
import {
  DEFAULT_ROTATION_TARGETS,
  PgRotationStore,
  rotateTarget,
  RotationTarget,
} from '../src/common/encryption/key-rotation';

const BATCH_SIZE = Number(process.env.ROTATION_BATCH_SIZE ?? 500);
const THROTTLE_MS = Number(process.env.ROTATION_THROTTLE_MS ?? 100);
const MAX_FAILURES = Number(process.env.ROTATION_MAX_FAILURES ?? 0);

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

function selectedTargets(): RotationTarget[] {
  const filter = process.env.ROTATION_TABLES?.split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!filter || filter.length === 0) return DEFAULT_ROTATION_TARGETS;
  return DEFAULT_ROTATION_TARGETS.filter((t) => filter.includes(t.table));
}

async function main(): Promise<void> {
  if (!isVersionedEncryptionEnabled()) {
    console.error(
      'ERROR: versioned encryption is not enabled. Set DB_FIELD_ENCRYPTION_KEY_VERSION ' +
        '(new key) and DB_FIELD_ENCRYPTION_KEY_PREVIOUS (old key) before rotating.',
    );
    process.exit(1);
  }

  const activeVersion = getActiveKeyVersion();
  const targets = selectedTargets();
  console.log(
    `Rotating ${targets.length} table(s) to key version ${activeVersion} ` +
      `(batchSize=${BATCH_SIZE}, throttleMs=${THROTTLE_MS}, maxFailures=${MAX_FAILURES})`,
  );

  await dataSource.initialize();
  console.log('Database connected');

  let hadFailures = false;
  try {
    for (const target of targets) {
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      try {
        const store = new PgRotationStore(qr);
        const result = await rotateTarget(store, target, {
          batchSize: BATCH_SIZE,
          throttleMs: THROTTLE_MS,
          maxFailures: MAX_FAILURES,
        });
        if (result.rowsFailed > 0) hadFailures = true;
      } finally {
        await qr.release();
      }
    }
  } finally {
    await dataSource.destroy();
  }

  if (hadFailures) {
    console.error('Rotation completed with row failures — see warnings above.');
    process.exit(1);
  }
  console.log(
    'Rotation complete. All PII fields are at the active key version.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
