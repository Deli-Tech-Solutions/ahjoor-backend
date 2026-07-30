import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { DistributedLockService } from '../scheduler/services/distributed-lock.service';
import { StellarCircuitBreakerService } from './stellar-circuit-breaker.service';
import { CongestionMonitorService } from './congestion-monitor.service';
import { WebhookService, WebhookEventType } from '../webhooks/webhook.service';
import { WinstonLogger } from '../common/logger/winston.logger';
import { Group } from '../groups/entities/group.entity';

interface AccountBalanceCheckResult {
  accountId: string;
  currentBalance: string;
  minimumRequired: string;
  isLow: boolean;
  timestamp: Date;
}

/**
 * BalanceMonitorService monitors Stellar account balances for the issuer account
 * and all active group escrow accounts. Emits alerts when balances fall below
 * the configured minimum threshold via the webhook system.
 *
 * Uses the circuit breaker to handle RPC downtime gracefully.
 * Consults congestion state to avoid misclassifying slow reads as balance discrepancies.
 */
@Injectable()
export class BalanceMonitorService {
  private readonly logger = new Logger(BalanceMonitorService.name);
  private readonly issuerAccount: string;
  private readonly minBalanceAlertXlm: number;
  private readonly checkIntervalMs: number;
  private readonly server: any;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;
  private previousLowBalanceAccounts: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreakerService: StellarCircuitBreakerService,
    private readonly congestionMonitor: CongestionMonitorService,
    private readonly webhookService: WebhookService,
    private readonly logger_: WinstonLogger,
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    private readonly lockService?: DistributedLockService,
  ) {
    this.issuerAccount = this.configService.get<string>(
      'STELLAR_ISSUER_ACCOUNT',
      '',
    );
    this.minBalanceAlertXlm = this.configService.get<number>(
      'STELLAR_MIN_BALANCE_ALERT_XLM',
      5,
    );
    this.checkIntervalMs = this.configService.get<number>(
      'BALANCE_CHECK_INTERVAL_MS',
      900000,
    ); // 15 minutes default

    this.rpcUrl = this.configService.get<string>('STELLAR_RPC_URL') ?? '';
    const network = (
      this.configService.get<string>('STELLAR_NETWORK', 'testnet') ?? 'testnet'
    ).toLowerCase();

    const StellarSdk = require('@stellar/stellar-sdk');
    const SorobanRpc = require('@stellar/stellar-sdk/rpc');

    const defaultPassphrase =
      network === 'mainnet'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    this.networkPassphrase =
      this.configService.get<string>(
        'STELLAR_NETWORK_PASSPHRASE',
        defaultPassphrase,
      ) ?? defaultPassphrase;

    this.server = new SorobanRpc.Server(this.rpcUrl, {
      allowHttp: this.rpcUrl.startsWith('http://'),
    });
  }

  /**
   * Scheduled task: Check account balances every 15 minutes (configurable)
   * Runs at startup and then on the configured interval
   */
  @Cron(CronExpression.EVERY_15_MINUTES, {
    name: 'monitor-stellar-balances',
  })
  async handleBalanceCheck(): Promise<void> {
    const taskName = 'monitor-stellar-balances';
    const startTime = Date.now();

    try {
      this.logger.log(`Starting task: ${taskName}`);

      // Use distributed lock if available, otherwise run directly
      if (this.lockService) {
        const result = await this.lockService.withLock(
          taskName,
          async () => {
            return await this.checkAllBalances();
          },
          600, // 10 minutes lock TTL
        );

        const duration = Date.now() - startTime;
        if (result) {
          this.logger.log(
            `Task ${taskName} completed successfully in ${duration}ms`,
          );
        } else {
          this.logger.warn(`Task ${taskName} was skipped (lock not acquired)`);
        }
      } else {
        // No lock service available, run directly
        await this.checkAllBalances();
        const duration = Date.now() - startTime;
        this.logger.log(`Task ${taskName} completed in ${duration}ms`);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Task ${taskName} failed after ${duration}ms: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * Check balances for issuer account and all active group accounts
   */
  private async checkAllBalances(): Promise<void> {
    const accountsToCheck: string[] = [];

    // Add issuer account
    if (this.issuerAccount) {
      accountsToCheck.push(this.issuerAccount);
    }

    // Add all active group contract accounts
    try {
      const activeGroups = await this.groupRepository.find({
        where: {
          contractAddress: this.issuerAccount ? null : undefined, // Fetch all with contract addresses
          deletedAt: LessThan(new Date(0)), // Not deleted
        },
        select: ['id', 'contractAddress'],
      });

      // Filter out null/undefined contract addresses
      const groupAccounts = activeGroups
        .filter(
          (g) => g.contractAddress && typeof g.contractAddress === 'string',
        )
        .map((g) => g.contractAddress as string);

      accountsToCheck.push(...groupAccounts);
    } catch (error) {
      this.logger.warn(
        `Failed to fetch active groups: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Continue with just the issuer account
    }

    // Remove duplicates
    const uniqueAccounts = [...new Set(accountsToCheck)];

    if (uniqueAccounts.length === 0) {
      this.logger.warn('No accounts configured for balance monitoring');
      return;
    }

    this.logger.debug(
      `Checking balances for ${uniqueAccounts.length} accounts`,
    );

    const results: AccountBalanceCheckResult[] = [];

    // Check each account with circuit breaker protection
    for (const accountId of uniqueAccounts) {
      try {
        const result = await this.circuitBreakerService.execute(async () => {
          return await this.checkAccountBalance(accountId);
        });
        results.push(result);
      } catch (error) {
        this.logger.error(
          `Failed to check balance for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Process results and emit alerts
    await this.processBalanceResults(results);
  }

  /**
   * Check balance for a single account
   */
  private async checkAccountBalance(
    accountId: string,
  ): Promise<AccountBalanceCheckResult> {
    const minBalanceXlm = parseFloat(this.minBalanceAlertXlm.toString());

    try {
      const account = await (this.circuitBreakerService as any).execute(() =>
        this.server.loadAccount(accountId),
      );
      const balances = account.balances as any[];

      // Find native XLM balance
      const nativeBalance = balances.find(
        (b: any) => b.asset_type === 'native',
      );
      const currentBalanceXlm = parseFloat(nativeBalance?.balance ?? '0');

      return {
        accountId,
        currentBalance: currentBalanceXlm.toString(),
        minimumRequired: minBalanceXlm.toString(),
        isLow: currentBalanceXlm < minBalanceXlm,
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(
        `Error loading account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Process balance check results and emit alerts for accounts with low balances.
   *
   * Key improvement: Consults congestion state to avoid misclassifying slow reads
   * as balance discrepancies. If the network is congested but operational, we're
   * more lenient about balance warnings since the read might be stale.
   */
  private async processBalanceResults(
    results: AccountBalanceCheckResult[],
  ): Promise<void> {
    const congestionState = this.congestionMonitor.getState();
    const isNetworkCongested = congestionState.isCongestioned;

    const currentLowBalanceAccounts = new Set<string>();

    for (const result of results) {
      if (result.isLow) {
        // During congestion, be cautious about low balance alerts
        // since the read might be stale or affected by network issues
        if (isNetworkCongested) {
          this.logger.warn(
            `Skipping low balance alert for ${result.accountId} due to network congestion (P99 latency: ${congestionState.p99LatencyMs}ms)`,
          );
          continue;
        }

        currentLowBalanceAccounts.add(result.accountId);

        // Only alert if this is a new low balance (wasn't low before)
        if (!this.previousLowBalanceAccounts.has(result.accountId)) {
          await this.emitLowBalanceAlert(result);
        }
      }
    }

    // Check for accounts that recovered from low balance
    for (const accountId of this.previousLowBalanceAccounts) {
      if (!currentLowBalanceAccounts.has(accountId)) {
        const result = results.find((r) => r.accountId === accountId);
        if (result) {
          await this.emitBalanceRecoveredAlert(result);
        }
      }
    }

    this.previousLowBalanceAccounts = currentLowBalanceAccounts;

    // Log summary
    if (currentLowBalanceAccounts.size > 0) {
      this.logger.warn(
        `${currentLowBalanceAccounts.size} account(s) have low balance: ${Array.from(currentLowBalanceAccounts).join(', ')}`,
      );
    }

    // Log congestion state for observability
    if (isNetworkCongested) {
      this.logger.warn(
        `Network congestion detected during balance check: P99=${congestionState.p99LatencyMs}ms, error rate=${(congestionState.errorRate * 100).toFixed(2)}%`,
      );
    }
  }

  /**
   * Emit low balance alert via webhook system
   */
  private async emitLowBalanceAlert(
    result: AccountBalanceCheckResult,
  ): Promise<void> {
    try {
      await this.webhookService.dispatchEvent(
        WebhookEventType.BALANCE_ALERT_LOW,
        {
          accountId: result.accountId,
          currentBalance: result.currentBalance,
          minimumRequired: result.minimumRequired,
          currency: 'XLM',
          timestamp: result.timestamp.toISOString(),
          severity: 'warning',
        },
      );

      this.logger_?.warn(
        `Low balance alert emitted for account ${result.accountId}: ${result.currentBalance} XLM (minimum: ${result.minimumRequired} XLM)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to emit low balance alert: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Emit balance recovered alert via webhook system
   */
  private async emitBalanceRecoveredAlert(
    result: AccountBalanceCheckResult,
  ): Promise<void> {
    try {
      await this.webhookService.dispatchEvent(
        WebhookEventType.BALANCE_ALERT_RECOVERED,
        {
          accountId: result.accountId,
          currentBalance: result.currentBalance,
          minimumRequired: result.minimumRequired,
          currency: 'XLM',
          timestamp: result.timestamp.toISOString(),
          severity: 'info',
        },
      );

      this.logger_?.info(
        `Balance recovered alert emitted for account ${result.accountId}: ${result.currentBalance} XLM`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to emit balance recovered alert: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get current balances for all monitored accounts (exposed via admin endpoint)
   */
  async getCurrentBalances(): Promise<AccountBalanceCheckResult[]> {
    const accountsToCheck: string[] = [];

    // Add issuer account
    if (this.issuerAccount) {
      accountsToCheck.push(this.issuerAccount);
    }

    // Add all active group contract accounts
    try {
      const activeGroups = await this.groupRepository.find({
        where: {
          deletedAt: LessThan(new Date(0)), // Not deleted
        },
        select: ['id', 'contractAddress'],
      });

      const groupAccounts = activeGroups
        .filter(
          (g) => g.contractAddress && typeof g.contractAddress === 'string',
        )
        .map((g) => g.contractAddress as string);

      accountsToCheck.push(...groupAccounts);
    } catch (error) {
      this.logger.warn(
        `Failed to fetch active groups: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Remove duplicates
    const uniqueAccounts = [...new Set(accountsToCheck)];
    const results: AccountBalanceCheckResult[] = [];

    for (const accountId of uniqueAccounts) {
      try {
        const result = await this.circuitBreakerService.execute(async () => {
          return await this.checkAccountBalance(accountId);
        });
        results.push(result);
      } catch (error) {
        this.logger.error(
          `Failed to check balance for account ${accountId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Add error result
        results.push({
          accountId,
          currentBalance: 'ERROR',
          minimumRequired: this.minBalanceAlertXlm.toString(),
          isLow: false,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }
}
