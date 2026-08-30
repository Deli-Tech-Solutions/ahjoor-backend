import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddPiiKeyRotationProgress
 *
 * Adds the checkpoint table used by the resumable, online encryption key
 * rotation job (scripts/rotate-encryption-keys.ts / src/common/encryption/
 * key-rotation.ts). One row per rotated table tracks the last processed
 * primary key and running counters so an interrupted rotation resumes exactly
 * where it stopped.
 */
export class AddPiiKeyRotationProgress1756500000000 implements MigrationInterface {
  name = 'AddPiiKeyRotationProgress1756500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "pii_encryption_key_rotation_progress" (
        "id"                 uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "target_table"       varchar(128)  NOT NULL,
        "target_key_version" integer       NOT NULL,
        "last_processed_id"  varchar(64),
        "rows_scanned"       bigint        NOT NULL DEFAULT 0,
        "rows_reencrypted"   bigint        NOT NULL DEFAULT 0,
        "rows_failed"        bigint        NOT NULL DEFAULT 0,
        "status"             varchar(20)   NOT NULL DEFAULT 'pending',
        "started_at"         timestamptz   NOT NULL DEFAULT now(),
        "updated_at"         timestamptz   NOT NULL DEFAULT now(),
        "completed_at"       timestamptz,
        CONSTRAINT "PK_pii_encryption_key_rotation_progress" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_pii_encryption_key_rotation_progress_target_table"
          UNIQUE ("target_table")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "pii_encryption_key_rotation_progress"`,
    );
  }
}
