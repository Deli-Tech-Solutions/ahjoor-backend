import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { AdminController } from './admin.controller';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditModule } from '../audit/audit.module';
import { BlockImpersonationGuard } from './block-impersonation.guard';
import { TrustScoreModule } from '../trust-score/trust-score.module';

@Module({
  imports: [
    ApiKeysModule,
    AuditModule,
    TrustScoreModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cs: ConfigService) => ({
        secret: cs.get<string>('JWT_ACCESS_SECRET') || 'default_access_secret',
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminGuard, BlockImpersonationGuard],
  exports: [AdminGuard, BlockImpersonationGuard],
})
export class AdminModule {}
