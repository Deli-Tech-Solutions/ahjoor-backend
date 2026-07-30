import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ContributionsService } from './contributions.service';

/**
 * Runs on startup and every minute to reconcile contributions stuck in
 * ON_CHAIN_SUBMITTED state (e.g. after a crash between DB write and Stellar confirmation).
 */
@Injectable()
export class ContributionReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContributionReconciliationService.name);

  constructor(private readonly contributionsService: ContributionsService) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Running startup contribution reconciliation');
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    try {
      await this.contributionsService.reconcileStuckContributions();
    } catch (err) {
      this.logger.error(
        `Reconciliation run failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
