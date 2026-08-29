import { MigrationInterface, QueryRunner } from 'typeorm';
import { createHash, randomUUID } from 'crypto';

/**
 * Adds tamper-evidence (hash chaining) to the `audit_logs` table.
 *
 * Each audit row stores:
 *  - `hash`          : SHA-256 of the row's canonical content plus the previous row's hash
 *  - `prevHash`      : the hash of the previous row in the chain (first row uses '')
 *  - `chainId`       : a stable UUID identifying the chain (all rows in the same chain)
 *  - `chainPartition`: partition key for per-entity-stream chains (default 'GLOBAL')
 *  - `chainVersion`  : bump when a legitimate schema migration/backfill changes the
 *                      canonical content so that the change is NOT mistaken for tampering
 *  - `anchorReference`: external anchor reference (e.g. Stellar tx hash)
 *
 * The migration backfills existing rows by walking them in (timestamp, id) order and
 * computing the hash chain, so pre-existing logs are valid members of the chain.
 *
 * Also creates the `audit_anchors` table — an append-only store for periodical
 * external anchoring of the chain head (Stellar manageData or write-once fallback).
 */
export class AddTamperEvidenceToAuditLogs1750000000000
  implements MigrationInterface
{
  name = 'AddTamperEvidenceToAuditLogs1750000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Add hash-chain columns to audit_logs ──────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "hash" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "prevHash" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainPartition" varchar(255) DEFAULT 'GLOBAL'`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "chainVersion" integer DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "anchorReference" varchar(255)`,
    );

    // ── 2. Backfill existing rows with a computed hash chain ──────────────────
    const rows: any[] = await queryRunner.query(
      `SELECT id, "userId", action, resource, metadata, timestamp, "ipAddress", "userAgent", "requestPayload"
       FROM "audit_logs"
       ORDER BY timestamp ASC, id ASC`,
    );

    if (rows.length > 0) {
      const chainId = randomUUID();
      let prevHash = '';

      for (const row of rows) {
        const content = this.canonicalizeRow({
          id: row.id,
          userId: row.userId ?? null,
          action: row.action ?? '',
          resource: row.resource ?? '',
          metadata: row.metadata ?? {},
          timestamp: new Date(row.timestamp).toISOString(),
          ipAddress: row.ipAddress ?? null,
          userAgent: row.userAgent ?? null,
          requestPayload: row.requestPayload ?? {},
          prevHash,
          chainId,
          chainPartition: 'GLOBAL',
          chainVersion: 1,
        });
        const hash = createHash('sha256').update(content).digest('hex');

        await queryRunner.query(
          `UPDATE "audit_logs"
           SET "hash" = $1, "prevHash" = $2, "chainId" = $3, "chainPartition" = 'GLOBAL', "chainVersion" = 1
           WHERE id = $4`,
          [hash, prevHash, chainId, row.id],
        );

        prevHash = hash;
      }
    }

    // ── 3. Index to walk the chain efficiently ────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_audit_chain"
       ON "audit_logs" ("chainId", "chainPartition", "timestamp" ASC, "id" ASC)`,
    );

    // ── 4. Append-only table for external anchoring ───────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_anchors" (
        "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
        "chainId" varchar(64) NOT NULL,
        "chainPartition" varchar(255) NOT NULL DEFAULT 'GLOBAL',
        "chainHeadHash" varchar(64) NOT NULL,
        "anchoredAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "anchorType" varchar(20) NOT NULL DEFAULT 'WRITE_ONCE',
        "stellarTxHash" varchar(255),
        "payload" jsonb,
        "sequence" bigserial UNIQUE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_audit_anchors_chain"
       ON "audit_anchors" ("chainId", "chainPartition", "sequence" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_anchors_chain"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_anchors"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_chain"`);
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "anchorReference"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "chainVersion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "chainPartition"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "chainId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "prevHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "hash"`,
    );
  }

  /**
   * Canonical serialisation of a row for hashing.
   * JSON keys are sorted recursively so the hash is deterministic and
   * independent of JSON key insertion order.
   */
  private canonicalizeRow(input: {
    id: string;
    userId: string | null;
    action: string;
    resource: string;
    metadata: Record<string, unknown>;
    timestamp: string;
    ipAddress: string | null;
    userAgent: string | null;
    requestPayload: Record<string, unknown>;
    prevHash: string;
    chainId: string;
    chainPartition: string;
    chainVersion: number;
  }): string {
    const canonical = {
      v: 1,
      id: input.id,
      userId: input.userId,
      action: input.action,
      resource: input.resource,
      metadata: this.stableStringify(input.metadata ?? {}),
      timestamp: input.timestamp,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      requestPayload: this.stableStringify(input.requestPayload ?? {}),
      prevHash: input.prevHash,
      chainId: input.chainId,
      chainPartition: input.chainPartition,
      chainVersion: input.chainVersion,
    };
    return JSON.stringify(canonical);
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.stableStringify(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${this.stableStringify(obj[k])}`)
      .join(',')}}`;
  }
}