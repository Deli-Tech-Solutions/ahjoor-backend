import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddKycProviderCaseTracking
 *
 * Adds provider-case tracking columns to kyc_documents so that resubmissions
 * can reuse an in-flight provider case instead of always creating a new one,
 * a stuck-in-pending detector can flag cases with no provider callback, and
 * provider failover can be reconciled without losing the audit trail.
 */
export class AddKycProviderCaseTracking1748300000000
  implements MigrationInterface
{
  name = 'AddKycProviderCaseTracking1748300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kyc_documents"
        ADD COLUMN "provider" varchar(20) NULL,
        ADD COLUMN "providerCaseId" varchar(255) NULL,
        ADD COLUMN "providerStatus" varchar(100) NULL,
        ADD COLUMN "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        ADD COLUMN "providerPayload" jsonb NULL,
        ADD COLUMN "submittedAt" timestamp NULL,
        ADD COLUMN "lastProviderEventAt" timestamp NULL,
        ADD COLUMN "caseExpiresAt" timestamp NULL,
        ADD COLUMN "stuckFlaggedAt" timestamp NULL,
        ADD COLUMN "documentSetHash" varchar(64) NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_kyc_documents_providerCaseId"
        ON "kyc_documents" ("providerCaseId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_kyc_documents_status_lastProviderEventAt"
        ON "kyc_documents" ("status", "lastProviderEventAt")
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "kyc_documents"."caseExpiresAt" IS
        'Provider case reuse validity boundary (submittedAt + KYC_CASE_REUSE_WINDOW_HOURS).'
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "kyc_documents"."stuckFlaggedAt" IS
        'Set by the stuck-in-pending detector cron job; cleared when a provider webhook event lands.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_kyc_documents_status_lastProviderEventAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_kyc_documents_providerCaseId"`,
    );

    await queryRunner.query(`
      ALTER TABLE "kyc_documents"
        DROP COLUMN "provider",
        DROP COLUMN "providerCaseId",
        DROP COLUMN "providerStatus",
        DROP COLUMN "status",
        DROP COLUMN "providerPayload",
        DROP COLUMN "submittedAt",
        DROP COLUMN "lastProviderEventAt",
        DROP COLUMN "caseExpiresAt",
        DROP COLUMN "stuckFlaggedAt",
        DROP COLUMN "documentSetHash"
    `);
  }
}
