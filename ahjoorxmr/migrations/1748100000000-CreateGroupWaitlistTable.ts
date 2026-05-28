import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateGroupWaitlistTable1748100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "group_waitlist_status_enum" AS ENUM ('WAITING', 'ADMITTED', 'CANCELLED')
    `);

    await queryRunner.query(`
      CREATE TABLE "group_waitlist" (
        "id"               UUID              NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt"        TIMESTAMP         NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP         NOT NULL DEFAULT now(),
        "groupId"          UUID              NOT NULL,
        "userId"           UUID              NOT NULL,
        "walletAddress"    VARCHAR(255)      NOT NULL DEFAULT '',
        "position"         INTEGER           NOT NULL,
        "joinedWaitlistAt" TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
        "status"           "group_waitlist_status_enum" NOT NULL DEFAULT 'WAITING',
        CONSTRAINT "PK_group_waitlist" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_group_waitlist_group_user" UNIQUE ("groupId", "userId"),
        CONSTRAINT "FK_group_waitlist_group" FOREIGN KEY ("groupId")
          REFERENCES "groups"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_group_waitlist_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_group_waitlist_groupId_position" ON "group_waitlist" ("groupId", "position")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_group_waitlist_groupId" ON "group_waitlist" ("groupId")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_group_waitlist_userId" ON "group_waitlist" ("userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "group_waitlist"`);
    await queryRunner.query(`DROP TYPE "group_waitlist_status_enum"`);
  }
}
