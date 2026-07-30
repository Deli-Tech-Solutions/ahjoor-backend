import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddContributionStateMachine1749000000000 implements MigrationInterface {
  name = 'AddContributionStateMachine1749000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add ON_CHAIN_SUBMITTED to the status enum
    await queryRunner.query(`
      ALTER TYPE contributions_status_enum ADD VALUE IF NOT EXISTS 'ON_CHAIN_SUBMITTED'
    `);

    // Add idempotency key column (nullable — back-filled on new submissions)
    await queryRunner.query(`
      ALTER TABLE "contributions"
      ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(36) NULL
    `);

    // Unique index so two rows can never share the same idempotency key
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_contributions_idempotencyKey"
      ON "contributions" ("idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
    `);

    // Index to speed up reconciliation queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_contributions_status_updatedAt"
      ON "contributions" ("status", "updatedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contributions_status_updatedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_contributions_idempotencyKey"`);
    await queryRunner.query(`ALTER TABLE "contributions" DROP COLUMN IF EXISTS "idempotencyKey"`);
    // Postgres does not support removing enum values; leave the enum as-is on rollback
  }
}
