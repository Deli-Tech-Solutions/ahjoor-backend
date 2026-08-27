import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FxService } from './fx.service';

/**
 * FX module provides multi-asset rate locking and normalization.
 * Exposes FxService for use by contributions, payouts, and penalties.
 */
@Module({
  imports: [ConfigModule],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}