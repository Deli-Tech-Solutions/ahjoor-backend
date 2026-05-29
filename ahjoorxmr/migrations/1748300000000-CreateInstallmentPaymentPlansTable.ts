import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateInstallmentPaymentPlansTable1748300000000
  implements MigrationInterface
{
  name = 'CreateInstallmentPaymentPlansTable1748300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TYPE installment_plan_status AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'PAUSED')",
    );

    await queryRunner.createTable(
      new Table({
        name: 'installment_payment_plans',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'uuid_generate_v4()',
          },
          {
            name: 'customerId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'merchantId',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'token',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'totalAmount',
            type: 'numeric',
            precision: 36,
            scale: 18,
            isNullable: false,
          },
          {
            name: 'numInstallments',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'intervalLedgers',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'currentInstallment',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'nextDueLedger',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'expiryLedger',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'installment_plan_status',
            default: "'ACTIVE'",
            isNullable: false,
          },
          {
            name: 'installmentAmounts',
            type: 'numeric',
            precision: 36,
            scale: 18,
            isArray: true,
            isNullable: false,
          },
          {
            name: 'paused',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'settlementTransactionHashes',
            type: 'text',
            isArray: true,
            default: "'{}'",
            isNullable: false,
          },
          {
            name: 'lastSettledAmount',
            type: 'numeric',
            precision: 36,
            scale: 18,
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp with time zone',
            default: 'now()',
          },
          {
            name: 'updatedAt',
            type: 'timestamp with time zone',
            default: 'now()',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'installment_payment_plans',
      new TableIndex({
        name: 'IDX_installment_payment_plans_customerId',
        columnNames: ['customerId'],
      }),
    );

    await queryRunner.createIndex(
      'installment_payment_plans',
      new TableIndex({
        name: 'IDX_installment_payment_plans_merchantId',
        columnNames: ['merchantId'],
      }),
    );

    await queryRunner.createForeignKeys('installment_payment_plans', [
      new TableForeignKey({
        columnNames: ['customerId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
      new TableForeignKey({
        columnNames: ['merchantId'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('installment_payment_plans', true);
    await queryRunner.query('DROP TYPE IF EXISTS installment_plan_status');
  }
}
