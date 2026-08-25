import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveriesTable1745300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "webhookId" uuid NOT NULL,
        "eventId" varchar(128) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "responseCode" integer,
        "responseBody" varchar(1024),
        "payload" text NOT NULL,
        "attemptNumber" integer NOT NULL DEFAULT 1,
        "attemptedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_webhook_deliveries_webhookId_eventId" UNIQUE ("webhookId", "eventId"),
        CONSTRAINT "FK_webhook_deliveries_webhook"
          FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_deliveries_webhookId_attemptedAt"
        ON "webhook_deliveries" ("webhookId", "attemptedAt")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
  }
}
