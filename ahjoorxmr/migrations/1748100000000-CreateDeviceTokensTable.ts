import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the device_tokens table for storing FCM and APNs push notification tokens.
 *
 * This table stores device tokens per user for mobile push notifications.
 * Each token is associated with a platform (FCM for Android, APN for iOS).
 */
export class CreateDeviceTokensTable1748100000000 implements MigrationInterface {
  name = 'CreateDeviceTokensTable1748100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum type for device platforms
    await queryRunner.query(`
      CREATE TYPE "device_platform_enum" AS ENUM ('fcm', 'apn')
    `);

    // Create device_tokens table
    await queryRunner.query(`
      CREATE TABLE "device_tokens" (
        "id"            UUID NOT NULL DEFAULT uuid_generate_v4(),
        "userId"        UUID NOT NULL,
        "token"         VARCHAR(255) NOT NULL,
        "platform"      "device_platform_enum" NOT NULL DEFAULT 'fcm',
        "deviceId"      VARCHAR(255) NULL,
        "deviceName"    VARCHAR(255) NULL,
        "appVersion"    VARCHAR(100) NULL,
        "lastUsedAt"    TIMESTAMP NULL,
        "isActive"      BOOLEAN NOT NULL DEFAULT false,
        "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_device_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_device_tokens_token" UNIQUE ("token"),
        CONSTRAINT "FK_device_tokens_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    // Create indexes for efficient lookups
    await queryRunner.query(`
      CREATE INDEX "IDX_device_tokens_userId_platform" ON "device_tokens" ("userId", "platform")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_device_tokens_userId_active" ON "device_tokens" ("userId", "isActive")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_device_tokens_platform" ON "device_tokens" ("platform")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_tokens_platform"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_tokens_userId_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_device_tokens_userId_platform"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_tokens"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "device_platform_enum"`);
  }
}
