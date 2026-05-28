import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateMemberTrustScoresTable
 *
 * Creates the member_trust_scores table which stores the aggregated,
 * cross-group trust score for each user based on their full payment history.
 */
export class CreateMemberTrustScoresTable1748200000000
  implements MigrationInterface
{
  name = 'CreateMemberTrustScoresTable1748200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "member_trust_scores" (
        "id"                          uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "userId"                      uuid              NOT NULL,
        "score"                       numeric(5,2)      NOT NULL DEFAULT 0,
        "totalGroupsParticipated"     integer           NOT NULL DEFAULT 0,
        "onTimeContributions"         integer           NOT NULL DEFAULT 0,
        "lateContributions"           integer           NOT NULL DEFAULT 0,
        "missedContributions"         integer           NOT NULL DEFAULT 0,
        "penaltiesIncurred"           integer           NOT NULL DEFAULT 0,
        "penaltiesPaid"               integer           NOT NULL DEFAULT 0,
        "groupsCompletedSuccessfully" integer           NOT NULL DEFAULT 0,
        "lastCalculatedAt"            timestamptz       NULL,
        "createdAt"                   timestamptz       NOT NULL DEFAULT now(),
        "updatedAt"                   timestamptz       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_member_trust_scores" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_member_trust_scores_userId" UNIQUE ("userId"),
        CONSTRAINT "FK_member_trust_scores_userId"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_member_trust_scores_userId"
        ON "member_trust_scores" ("userId")
    `);

    await queryRunner.query(`
      COMMENT ON TABLE "member_trust_scores" IS
        'Aggregated cross-group trust score for each user, recalculated nightly by the RECALCULATE_TRUST_SCORES BullMQ job.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_member_trust_scores_userId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "member_trust_scores"`);
  }
}
