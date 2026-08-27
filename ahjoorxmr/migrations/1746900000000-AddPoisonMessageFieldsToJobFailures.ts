import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPoisonMessageFieldsToJobFailures1746900000000
  implements MigrationInterface
{
  name = 'AddPoisonMessageFieldsToJobFailures1746900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "job_failures"
        ADD COLUMN IF NOT EXISTS "isPoison" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "failureSignature" VARCHAR(64),
        ADD COLUMN IF NOT EXISTS "errorClass" VARCHAR(128)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_job_failures_is_poison"
        ON "job_failures" ("isPoison")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_job_failures_is_poison"`);
    await queryRunner.query(`
      ALTER TABLE "job_failures"
        DROP COLUMN IF EXISTS "isPoison",
        DROP COLUMN IF EXISTS "consecutiveFailures",
        DROP COLUMN IF EXISTS "failureSignature",
        DROP COLUMN IF EXISTS "errorClass"
    `);
  }
}