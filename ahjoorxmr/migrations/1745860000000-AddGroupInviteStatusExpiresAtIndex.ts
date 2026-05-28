import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a composite index on (status, expiresAt) to the group_invites table.
 *
 * Index strategy:
 *  - idx_group_invites_status_expiresAt: composite (status, expiresAt) for
 *    efficient lookup of expired pending invites during cleanup jobs.
 *
 * This index optimizes queries that filter by status = 'ACTIVE' AND expiresAt < NOW()
 * which are used by the scheduled job to prune expired group invites.
 *
 * Usage example (confirms index scan):
 *   EXPLAIN ANALYZE
 *   UPDATE group_invites
 *   SET status = 'EXPIRED'
 *   WHERE status = 'ACTIVE' AND expiresAt < NOW();
 */
export class AddGroupInviteStatusExpiresAtIndex1745860000000 implements MigrationInterface {
  name = 'AddGroupInviteStatusExpiresAtIndex1745860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_group_invites_status_expiresAt" ON "group_invites" ("status", "expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_group_invites_status_expiresAt"`);
  }
}
