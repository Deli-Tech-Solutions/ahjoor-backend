import {
  decrypt,
  encrypt,
  getActiveKeyVersion,
  getCiphertextKeyVersion,
} from './field-encryption.transformer';

/**
 * Online, resumable, throttled re-encryption of PII columns for encryption key
 * rotation.
 *
 * The engine is storage-agnostic: it drives a {@link RotationStore}. A Postgres
 * implementation ({@link PgRotationStore}) is provided for the rotation script;
 * tests use an in-memory store.
 *
 * Guarantees:
 *  - Zero downtime: readers keep working because {@link decrypt} resolves both
 *    the old and new key while rotation is in flight.
 *  - Resumable: progress (last processed primary key + counters) is persisted
 *    per table after every batch, so an interrupted run continues where it
 *    stopped.
 *  - Throttled: a configurable pause between batches keeps write load bounded.
 *  - Idempotent: re-running after completion re-scans nothing because every
 *    value is already at the active key version.
 */

export const ROTATION_PROGRESS_TABLE = 'pii_encryption_key_rotation_progress';

export type RotationStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RotationTarget {
  /** Physical table name. */
  table: string;
  /** Primary key column used for keyset pagination. Defaults to `id`. */
  idColumn?: string;
  /** Encrypted columns to re-encrypt. */
  columns: string[];
}

export interface StoredProgress {
  targetTable: string;
  targetKeyVersion: number;
  lastProcessedId: string | null;
  rowsScanned: number;
  rowsReencrypted: number;
  rowsFailed: number;
  status: RotationStatus;
}

export interface RotationRow {
  id: string;
  [column: string]: string | null;
}

export interface RotationStore {
  loadProgress(table: string): Promise<StoredProgress | null>;
  saveProgress(progress: StoredProgress): Promise<void>;
  fetchBatch(
    target: RotationTarget,
    afterId: string | null,
    limit: number,
  ): Promise<RotationRow[]>;
  updateRow(
    target: RotationTarget,
    id: string,
    values: Record<string, string>,
  ): Promise<void>;
  /** Run `fn` inside a single DB transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface RotationOptions {
  batchSize?: number;
  /** Milliseconds to pause between batches. */
  throttleMs?: number;
  /** Stop after this many batches (leaves progress `running` so it can resume). */
  maxBatches?: number;
  /**
   * Abort the run once this many rows fail to decrypt. Defaults to 0 — any
   * undecryptable row aborts, since that signals a key/config problem.
   */
  maxFailures?: number;
  onBatch?: (progress: StoredProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface RotationResult extends StoredProgress {
  batchesRun: number;
  done: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-encrypt every value in `target.columns` that is not already at the active
 * key version. Safe to call repeatedly and to interrupt.
 */
export async function rotateTarget(
  store: RotationStore,
  target: RotationTarget,
  options: RotationOptions = {},
): Promise<RotationResult> {
  const activeVersion = getActiveKeyVersion();
  if (activeVersion === null) {
    throw new Error(
      'Key rotation requires versioned encryption. Set DB_FIELD_ENCRYPTION_KEY_VERSION (and keep the old key as DB_FIELD_ENCRYPTION_KEY_PREVIOUS) before running rotation.',
    );
  }

  const batchSize = options.batchSize ?? 500;
  const throttleMs = options.throttleMs ?? 0;
  const maxFailures = options.maxFailures ?? 0;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? console;
  const idColumn = target.idColumn ?? 'id';

  const loaded = await store.loadProgress(target.table);
  const progress: StoredProgress =
    loaded && loaded.targetKeyVersion === activeVersion
      ? { ...loaded, status: 'running' }
      : {
          // First run, or a new rotation campaign towards a newer key version:
          // start a fresh scan from the beginning.
          targetTable: target.table,
          targetKeyVersion: activeVersion,
          lastProcessedId: null,
          rowsScanned: 0,
          rowsReencrypted: 0,
          rowsFailed: 0,
          status: 'running',
        };

  if (
    loaded?.targetKeyVersion === activeVersion &&
    loaded.status === 'completed'
  ) {
    logger.log(
      `[rotate:${target.table}] already at key version ${activeVersion}; nothing to do`,
    );
    return { ...loaded, batchesRun: 0, done: true };
  }
  await store.saveProgress(progress);

  const finish = (
    status: RotationStatus,
    batchesRun: number,
    done: boolean,
  ): RotationResult => {
    progress.status = status;
    logger.log(
      `[rotate:${target.table}] ${status} — scanned ${progress.rowsScanned}, re-encrypted ${progress.rowsReencrypted}, failed ${progress.rowsFailed}`,
    );
    return { ...progress, batchesRun, done };
  };

  let batchesRun = 0;

  while (true) {
    if (options.maxBatches != null && batchesRun >= options.maxBatches) {
      await store.saveProgress(progress);
      return { ...progress, batchesRun, done: false };
    }

    const rows = await store.fetchBatch(
      target,
      progress.lastProcessedId,
      batchSize,
    );
    if (rows.length === 0) {
      await store.saveProgress({ ...progress, status: 'completed' });
      return finish('completed', batchesRun, true);
    }

    // Re-encryption is pure (no DB); do it first, then write the batch + the
    // progress checkpoint in one transaction.
    const rowUpdates: Array<{ id: string; values: Record<string, string> }> =
      [];
    for (const row of rows) {
      const rowId = String(row[idColumn] ?? row.id);
      progress.rowsScanned += 1;
      const values: Record<string, string> = {};
      for (const column of target.columns) {
        const value = row[column];
        if (value == null || value === '') continue;
        if (getCiphertextKeyVersion(value) === activeVersion) continue;
        try {
          values[column] = encrypt(decrypt(value));
        } catch (err) {
          progress.rowsFailed += 1;
          logger.warn(
            `[rotate:${target.table}] row ${rowId} column "${column}" failed: ${
              (err as Error).message
            }`,
          );
        }
      }
      if (Object.keys(values).length > 0)
        rowUpdates.push({ id: rowId, values });
      progress.lastProcessedId = rowId;
    }

    await store.transaction(async () => {
      for (const { id, values } of rowUpdates) {
        await store.updateRow(target, id, values);
        progress.rowsReencrypted += 1;
      }
      await store.saveProgress(progress);
    });

    batchesRun += 1;
    options.onBatch?.({ ...progress });

    if (progress.rowsFailed > maxFailures) {
      await store.saveProgress({ ...progress, status: 'failed' });
      progress.status = 'failed';
      throw new Error(
        `[rotate:${target.table}] aborting: ${progress.rowsFailed} row(s) failed to decrypt (maxFailures=${maxFailures})`,
      );
    }

    if (rows.length < batchSize) {
      await store.saveProgress({ ...progress, status: 'completed' });
      return finish('completed', batchesRun, true);
    }

    if (throttleMs > 0) await sleep(throttleMs);
  }
}

/* -------------------------------------------------------------------------- */
/*  Postgres store                                                            */
/* -------------------------------------------------------------------------- */

export interface QueryRunnerLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
}

/**
 * {@link RotationStore} backed by a TypeORM QueryRunner (single dedicated
 * connection). Each batch runs in its own transaction so an interrupted run
 * never leaves a partially-written batch.
 */
interface ProgressDbRow {
  target_table: string;
  target_key_version: number | string;
  last_processed_id: string | null;
  rows_scanned: number | string;
  rows_reencrypted: number | string;
  rows_failed: number | string;
  status: RotationStatus;
}

export class PgRotationStore implements RotationStore {
  constructor(private readonly qr: QueryRunnerLike) {}

  async loadProgress(table: string): Promise<StoredProgress | null> {
    const rows = await this.qr.query<ProgressDbRow[]>(
      `SELECT "target_table", "target_key_version", "last_processed_id",
              "rows_scanned", "rows_reencrypted", "rows_failed", "status"
       FROM "${ROTATION_PROGRESS_TABLE}" WHERE "target_table" = $1`,
      [table],
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      targetTable: r.target_table,
      targetKeyVersion: Number(r.target_key_version),
      lastProcessedId: r.last_processed_id,
      rowsScanned: Number(r.rows_scanned),
      rowsReencrypted: Number(r.rows_reencrypted),
      rowsFailed: Number(r.rows_failed),
      status: r.status,
    };
  }

  async saveProgress(progress: StoredProgress): Promise<void> {
    await this.qr.query(
      `INSERT INTO "${ROTATION_PROGRESS_TABLE}"
         ("target_table", "target_key_version", "last_processed_id",
          "rows_scanned", "rows_reencrypted", "rows_failed", "status", "updated_at",
          "completed_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(),
               CASE WHEN $7 = 'completed' THEN now() ELSE NULL END)
       ON CONFLICT ("target_table") DO UPDATE SET
         "target_key_version" = EXCLUDED."target_key_version",
         "last_processed_id"  = EXCLUDED."last_processed_id",
         "rows_scanned"       = EXCLUDED."rows_scanned",
         "rows_reencrypted"   = EXCLUDED."rows_reencrypted",
         "rows_failed"        = EXCLUDED."rows_failed",
         "status"             = EXCLUDED."status",
         "updated_at"         = now(),
         "completed_at"       = CASE
           WHEN EXCLUDED."status" = 'completed' THEN now()
           ELSE "${ROTATION_PROGRESS_TABLE}"."completed_at"
         END`,
      [
        progress.targetTable,
        progress.targetKeyVersion,
        progress.lastProcessedId,
        progress.rowsScanned,
        progress.rowsReencrypted,
        progress.rowsFailed,
        progress.status,
      ],
    );
  }

  async fetchBatch(
    target: RotationTarget,
    afterId: string | null,
    limit: number,
  ): Promise<RotationRow[]> {
    const idColumn = target.idColumn ?? 'id';
    const cols = [idColumn, ...target.columns].map((c) => `"${c}"`).join(', ');
    const where = afterId == null ? '' : `WHERE "${idColumn}" > $2`;
    const params: unknown[] = afterId == null ? [limit] : [limit, afterId];
    const rows = await this.qr.query<Array<Record<string, string | null>>>(
      `SELECT ${cols} FROM "${target.table}" ${where}
       ORDER BY "${idColumn}" ASC LIMIT $1`,
      params,
    );
    return rows.map((r) => ({ ...r, id: String(r[idColumn]) }));
  }

  async updateRow(
    target: RotationTarget,
    id: string,
    values: Record<string, string>,
  ): Promise<void> {
    const idColumn = target.idColumn ?? 'id';
    const entries = Object.entries(values);
    const set = entries.map(([col], i) => `"${col}" = $${i + 1}`).join(', ');
    const params = [...entries.map(([, v]) => v), id];
    await this.qr.query(
      `UPDATE "${target.table}" SET ${set} WHERE "${idColumn}" = $${
        entries.length + 1
      }`,
      params,
    );
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.qr.startTransaction();
    try {
      const result = await fn();
      await this.qr.commitTransaction();
      return result;
    } catch (err) {
      await this.qr.rollbackTransaction();
      throw err;
    }
  }
}

/** Default PII targets in this codebase (see field-encryption migration). */
export const DEFAULT_ROTATION_TARGETS: RotationTarget[] = [
  { table: 'users', columns: ['email', 'twoFactorSecret'] },
  { table: 'kyc_documents', columns: ['documentNumber'] },
];
