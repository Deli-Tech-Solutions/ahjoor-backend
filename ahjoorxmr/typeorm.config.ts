import { DataSource } from 'typeorm';
import { ConfigModule } from '@nestjs/config';
import { User } from './src/users/entities/user.entity';
import { Group } from './src/groups/entities/group.entity';
import { Membership } from './src/memberships/entities/membership.entity';
import { Contribution } from './src/contributions/entities/contribution.entity';
import { AuditLog } from './src/audit/entities/audit-log.entity';
import { PayoutTransaction } from './src/groups/entities/payout-transaction.entity';
import { KycDocument } from './src/kyc/entities/kyc-document.entity';

// Initialize config
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: '.env',
});

/**
 * TypeORM DataSource configuration for CLI migrations.
 * This file is separate from the NestJS app config to allow the TypeORM CLI
 * to load it independently for migration generation and execution.
 * 
 * Uses PostgreSQL with environment-based configuration.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ahjoorxmr',
  
  entities: [User, Group, Membership, Contribution, AuditLog, PayoutTransaction, KycDocument],
  migrations: ['migrations/*.ts'],
  
  // Never use synchronize with migrations
  synchronize: false,
  
  // Enable logging for migration operations
  logging: process.env.DB_LOGGING === 'true',
  
  // Connection pooling
  extra: {
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
    min: parseInt(process.env.DB_POOL_MIN || '2', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000', 10),
  },
});
