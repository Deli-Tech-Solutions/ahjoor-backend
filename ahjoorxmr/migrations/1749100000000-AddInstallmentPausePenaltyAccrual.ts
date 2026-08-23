import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds pause-clock fields to installment_payment_plan and backfills currently
 * paused rows without inventing historical pause duration or reversing penalties.
 *
 * Policy: see src/payments/installment-pause.constants.ts
 */
export class AddInstallmentPausePenaltyAccrual1749100000000
  implements MigrationInterface
{
  name = 'AddInstallmentPausePenaltyAccrual1749100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "installment_payment_plan_status_enum" AS ENUM (
          'ACTIVE', 'COMPLETED', 'EXPIRED', 'PAUSED'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "installment_payment_plan" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "token" character varying NOT NULL,
        "totalAmount" numeric(36,18) NOT NULL,
        "numInstallments" integer NOT NULL,
        "intervalLedgers" integer NOT NULL,
        "currentInstallment" integer NOT NULL,
        "nextDueLedger" integer NOT NULL,
        "expiryLedger" integer NOT NULL,
        "status" "installment_payment_plan_status_enum" NOT NULL DEFAULT 'ACTIVE',
        "installmentAmounts" numeric(36,18) array NOT NULL,
        "paused" boolean NOT NULL DEFAULT false,
        "pausedAtLedger" integer NULL,
        "pausedAt" TIMESTAMPTZ NULL,
        "totalPausedLedgers" integer NOT NULL DEFAULT 0,
        "pauseCount" integer NOT NULL DEFAULT 0,
        "lastResumedAtLedger" integer NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "customerId" uuid NOT NULL,
        "merchantId" uuid NOT NULL,
        CONSTRAINT "PK_installment_payment_plan" PRIMARY KEY ("id")
      )
    `);

    // Columns for tables that already existed via synchronize / prior deploys
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan"
        ADD COLUMN IF NOT EXISTS "pausedAtLedger" integer NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan"
        ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan"
        ADD COLUMN IF NOT EXISTS "totalPausedLedgers" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan"
        ADD COLUMN IF NOT EXISTS "pauseCount" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan"
        ADD COLUMN IF NOT EXISTS "lastResumedAtLedger" integer NULL
    `);

    // Backfill: currently paused plans — anchor pause at updatedAt, count as 1 pause.
    // Do NOT invent pausedAtLedger or totalPausedLedgers (unknown under old behavior).
    // On first resume after deploy, null pausedAtLedger is treated as currentLedger
    // (zero shift) so we never invent historical duration or reverse penalties.
    await queryRunner.query(`
      UPDATE "installment_payment_plan"
      SET
        "pausedAt" = COALESCE("pausedAt", "updatedAt"),
        "pauseCount" = CASE WHEN "pauseCount" < 1 THEN 1 ELSE "pauseCount" END
      WHERE "paused" = true OR "status" = 'PAUSED'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "installment_payment_plan"."totalPausedLedgers" IS
        'Cumulative ledgers spent paused; used to keep nextDueLedger as the effective due after pause/resume cycles.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "installment_payment_plan"."pausedAtLedger" IS
        'Ledger when current pause began; null when active. Resume shifts due/expiry by (current - pausedAtLedger).'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan" DROP COLUMN IF EXISTS "lastResumedAtLedger"
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan" DROP COLUMN IF EXISTS "pauseCount"
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan" DROP COLUMN IF EXISTS "totalPausedLedgers"
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan" DROP COLUMN IF EXISTS "pausedAt"
    `);
    await queryRunner.query(`
      ALTER TABLE "installment_payment_plan" DROP COLUMN IF EXISTS "pausedAtLedger"
    `);
  }
}
