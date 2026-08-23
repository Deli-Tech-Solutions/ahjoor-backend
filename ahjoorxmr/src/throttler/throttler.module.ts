import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { RedisModule } from '../common/redis/redis.module';
import { RedisService } from '../common/redis/redis.service';
import { RedisThrottlerStorageService } from './redis-throttler-storage.service';
import { getThrottlerConfig } from './throttler.config';
import { TrustedIpService } from './services/trusted-ip.service';
import { CustomThrottlerGuard } from './guards/custom-throttler.guard';
import { WalletThrottlerGuard } from './guards/wallet-throttler.guard';
import { RateLimitAdminController } from './controllers/rate-limit-admin.controller';
import { RateLimitExampleController } from './controllers/rate-limit-example.controller';

/**
 * Custom throttler module with Redis storage and advanced features.
 * Storage is wired as a constructed instance via forRootAsync so Nest uses the
 * DI-backed Redis client (passing the class token alone is not enough).
 */
@Module({
  imports: [
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redisService: RedisService) => {
        const storage = new RedisThrottlerStorageService(redisService);
        return {
          ...getThrottlerConfig(),
          storage,
        };
      },
    }),
  ],
  controllers: [RateLimitAdminController, RateLimitExampleController],
  providers: [
    WalletThrottlerGuard,
    RedisThrottlerStorageService,
    TrustedIpService,
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
  ],
  exports: [
    ThrottlerModule,
    RedisThrottlerStorageService,
    TrustedIpService,
    WalletThrottlerGuard,
  ],
})
export class CustomThrottlerModule {}
