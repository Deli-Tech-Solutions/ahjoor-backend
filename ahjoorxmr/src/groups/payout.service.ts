import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common';
import { OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Group } from '../groups/entities/group.entity';
import { Membership } from '../memberships/entities/membership.entity';
import { GroupStatus } from '../groups/entities/group-status.enum';
import { StellarService } from '../stellar/stellar.service';
import { NotificationsService } from '../notification/notifications.service';
import { NotificationType } from '../notification/notification-type.enum';
import { PayoutTransaction } from './entities/payout-transaction.entity';
import { PayoutTransactionStatus } from './entities/payout-transaction-status.enum';
import { QueueService } from '../bullmq/queue.service';
import { Penalty, PenaltyStatus } from '../penalties/entities/penalty.entity';
import { FxService } from '../fx/fx.service';
import { PathPaymentOutcome, PathPaymentResult } from '../fx/fx.types';
import { Contribution, ContributionStatus } from '../contributions/entities/contribution.entity';
import { Decimal } from 'decimal.js';

@Injectable()
export class PayoutService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectRepository(Group)
    private readonly groupRepository: Repository<Group>,
    @InjectRepository(Membership)
    private readonly membershipRepository: Repository<Membership>,
    @InjectRepository(PayoutTransaction)
    private readonly payoutTransactionRepository: Repository<PayoutTransaction>,
    @InjectRepository(Penalty)
    private readonly penaltyRepository: Repository<Penalty>,
    @InjectRepository(Contribution)
    private readonly contributionRepository: Repository<Contribution>,
    private readonly stellarService: StellarService,
    private readonly notificationsService: NotificationsService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
    private readonly fxService: FxService,
  ) {}

  /**
   * Distributes payout for a given group and round.
   * Finds the member whose payoutOrder matches the round (0-indexed).
   * Invokes the Soroban contract's payout method.
   * On success, updates membership and emits notification.
   */
  async distributePayout(groupId: string, round: number): Promise<string> {
    this.logger.log(
      `Starting payout distribution for group ${groupId}, round ${round}`,
    );

    const group = await this.groupRepository.findOne({
      where: { id: groupId },
    });

    if (!group) {
      throw new NotFoundException('Group not found');
    }

    if (group.status !== GroupStatus.ACTIVE) {
      throw new BadRequestException(
        'Group must be ACTIVE to distribute payout',
      );
    }

    if (!group.contractAddress) {
      throw new BadRequestException('Group has no contract address');
    }

    // payoutOrder is 0-indexed, round is 1-indexed
    const expectedPayoutOrder = round - 1;

    const recipient = await this.membershipRepository.findOne({
      where: { groupId, payoutOrder: expectedPayoutOrder },
    });

    if (!recipient) {
      throw new NotFoundException(
        `No member scheduled for payout in round ${round} (payoutOrder ${expectedPayoutOrder})`,
      );
    }

    if (recipient.hasReceivedPayout) {
      this.logger.warn(
        `Member ${recipient.userId} has already received payout for group ${groupId}`,
      );
      throw new ConflictException('Member has already received payout');
    }

    const outstandingPenalties = await this.penaltyRepository.count({
      where: {
        userId: recipient.userId,
        groupId,
        status: In([PenaltyStatus.PENDING]),
      },
    });

    if (outstandingPenalties > 0) {
      this.logger.warn(
        `Payout blocked for user ${recipient.userId} in group ${groupId}: ${outstandingPenalties} outstanding penalty(ies)`,
      );
      await this.notificationsService.notify({
        userId: recipient.userId,
        type: NotificationType.PAYOUT_BLOCKED_PENDING_PENALTY,
        title: 'Payout Blocked',
        body: `Your payout for group "${group.name}" is blocked due to ${outstandingPenalties} outstanding penalty(ies). Please settle them first.`,
        metadata: { groupId, round, outstandingPenalties },
      });
      throw new BadRequestException(
        `Payout blocked: recipient has ${outstandingPenalties} outstanding penalty(ies) in this group`,
      );
    }

    this.logger.log(
      `Disbursing payout to ${recipient.walletAddress} (User: ${recipient.userId}) for group ${groupId}, round ${round}`,
    );

    const payoutOrderId = this.buildPayoutOrderId(groupId, round);
    const existingPayoutTransaction =
      await this.payoutTransactionRepository.findOne({
        where: { payoutOrderId },
      });

    if (existingPayoutTransaction) {
      this.logger.warn(
        `Payout transaction already exists for ${payoutOrderId}; returning existing state ${existingPayoutTransaction.status}`,
      );

      if (
        existingPayoutTransaction.status === PayoutTransactionStatus.SUBMITTED
      ) {
        await this.queueService.addPayoutReconciliation({
          payoutTransactionId: existingPayoutTransaction.id,
        });
      }

      return (
        existingPayoutTransaction.txHash ??
        `payout_${existingPayoutTransaction.status.toLowerCase()}_${existingPayoutTransaction.id}`
      );
    }

    // Payout asset = the group's unit of account.
    const payoutAssetCode = group.unitOfAccountAssetCode ?? group.assetCode ?? 'XLM';
    const payoutAssetIssuer = group.unitOfAccountAssetIssuer ?? group.assetIssuer ?? null;

    // Compute the payout amount normalized to the unit of account.
    // Round total = sum of normalized contribution amounts; fall back to the
    // configured contribution amount when no contributions are recorded.
    const payoutAmount = await this.computePayoutAmount(groupId, round, group);

    const payoutTransaction = this.payoutTransactionRepository.create({
      payoutOrderId,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
      assetCode: payoutAssetCode,
      assetIssuer: payoutAssetIssuer,
      requestedAmount: payoutAmount,
    });
    await this.payoutTransactionRepository.save(payoutTransaction);

    let txHash: string;
    try {
      // If the payout asset differs from the group's declared contribution
      // asset, use a path payment to deliver the normalized amount with FX
      // rate honored. Otherwise use the direct contract call.
      const contributionAssetCode = (group.assetCode ?? 'XLM').toUpperCase();
      const needsPathPayment =
        contributionAssetCode !== payoutAssetCode.toUpperCase();

      if (needsPathPayment) {
        // The contract holds the contribution asset; converting to the unit of
        // account at settlement follows the locked rates captured on the
        // contributions. Use rate `1` (the payout is already normalized) and a
        // tolerance band from the group policy.
        const result: PathPaymentResult =
          await this.stellarService.submitPathPayment(
            contributionAssetCode,
            group.assetIssuer ?? null,
            payoutAssetCode,
            payoutAssetIssuer,
            payoutAmount,
            '1',
            group.fxToleranceBps ?? 200,
            recipient.walletAddress,
          );

        if (
          result.outcome === PathPaymentOutcome.SLIPPAGE_EXCEEDED ||
          result.outcome === PathPaymentOutcome.FAILED
        ) {
          payoutTransaction.status = PayoutTransactionStatus.FAILED;
          payoutTransaction.failureReason = result.reason ?? result.outcome;
          payoutTransaction.pathPaymentOutcome = result.outcome;
          await this.payoutTransactionRepository.save(payoutTransaction);
          throw new BadGatewayException(
            `Payout conversion ${result.outcome}: ${result.reason ?? 'Path payment failed'}`,
          );
        }

        txHash = result.txHash ?? `payout_${payoutOrderId}`;
        payoutTransaction.txHash = txHash;
        payoutTransaction.deliveredAmount = result.deliveredAmount;
        payoutTransaction.pathPaymentOutcome = result.outcome;
        payoutTransaction.fxRate = result.lockedRate;
      } else {
        txHash = await this.stellarService.disbursePayout(
          group.contractAddress,
          recipient.walletAddress,
          payoutAmount,
          async (calculatedHash: string) => {
            payoutTransaction.txHash = calculatedHash;
            await this.payoutTransactionRepository.save(payoutTransaction);
          },
          payoutAssetCode,
          payoutAssetIssuer,
        );

        payoutTransaction.txHash = txHash;
        payoutTransaction.deliveredAmount = payoutAmount;
        payoutTransaction.pathPaymentOutcome = PathPaymentOutcome.FULL_FILL;
      }

      if (
        this.configService.get<string>(
          'SIMULATE_PAYOUT_CRASH_AFTER_SUBMIT',
          'false',
        ) === 'true'
      ) {
        throw new Error(
          'Simulated crash after submitTransaction and before status update',
        );
      }

      payoutTransaction.status = PayoutTransactionStatus.SUBMITTED;
      await this.payoutTransactionRepository.save(payoutTransaction);

      await this.queueService.addPayoutReconciliation({
        payoutTransactionId: payoutTransaction.id,
      });
    } catch (error) {
      if (!payoutTransaction.txHash) {
        payoutTransaction.status = PayoutTransactionStatus.FAILED;
        await this.payoutTransactionRepository.save(payoutTransaction);
      }

      this.logger.error(
        `Failed to disburse payout for group ${groupId}, round ${round}: ${error.message}`,
        error.stack,
      );
      // Requirement: Failed contract invocation returns a 502 to the caller.
      throw new BadGatewayException(
        `Contract invocation failed: ${error.message}`,
      );
    }

    // On success, set membership.hasReceivedPayout = true and record transaction hash
    recipient.hasReceivedPayout = true;
    recipient.transactionHash = txHash;
    await this.membershipRepository.save(recipient);

    this.logger.log(
      `Payout successful for group ${groupId}, round ${round}. TxHash: ${txHash}`,
    );

    // Emit a PAYOUT_RECEIVED notification to the recipient with the transaction hash
    try {
      await this.notificationsService.notify({
        userId: recipient.userId,
        type: NotificationType.PAYOUT_RECEIVED,
        title: 'Payout Received',
        body: `You have received your payout for round ${round} in group "${group.name}".`,
        metadata: {
          groupId: group.id,
          round,
          transactionHash: txHash,
          amount: group.contributionAmount,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to send PAYOUT_RECEIVED notification to user ${recipient.userId}: ${error.message}`,
      );
      // Don't fail the whole process if notification fails
    }

    return txHash;
  }

  private buildPayoutOrderId(groupId: string, round: number): string {
    return `${groupId}:${round}`;
  }

  /**
   * Computes the payout amount for a round, normalized to the group's
   * unit-of-account asset.
   *
   * The round total is the sum of all confirmed contributions' normalized
   * amounts (each contribution is normalized to the unit of account using its
   * locked FX rate). If no contributions are recorded, falls back to the
   * configured contribution amount.
   *
   * @param groupId - The group UUID.
   * @param round - The round number (1-indexed).
   * @param group - The group entity (for fallback amount).
   * @returns The payout amount as a string.
   */
  private async computePayoutAmount(
    groupId: string,
    round: number,
    group: Group,
  ): Promise<string> {
    const contributions = await this.contributionRepository.find({
      where: {
        groupId,
        roundNumber: round,
        status: ContributionStatus.CONFIRMED,
      },
    });

    if (contributions.length === 0) {
      return group.contributionAmount;
    }

    let total = new Decimal(0);
    for (const contribution of contributions) {
      // Prefer the normalized amount (unit of account); fall back to the raw
      // amount multiplied by the locked FX rate.
      const amount = contribution.normalizedAmount
        ? new Decimal(contribution.normalizedAmount)
        : new Decimal(contribution.amount).times(
            new Decimal(contribution.fxRate ?? '1'),
          );
      total = total.plus(amount);
    }

    return total.toFixed(7);
  }

  async onApplicationBootstrap() {
    this.logger.log(
      'Startup reconciliation sweep: enqueuing jobs for PENDING_SUBMISSION rows with non-null txHash',
    );
    await this.pollUnconfirmedPayouts();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async pollUnconfirmedPayouts() {
    this.logger.log('Polling unconfirmed payout transactions for reconciliation...');
    const unconfirmedTransactions = await this.payoutTransactionRepository.find({
      where: [
        { status: PayoutTransactionStatus.SUBMITTED },
        { status: PayoutTransactionStatus.PENDING_SUBMISSION },
      ],
    });

    const toProcess = unconfirmedTransactions.filter(
      (tx) => tx.txHash !== null
    );

    for (const transaction of toProcess) {
      this.logger.debug(`Enqueuing reconciliation for payoutTransaction ${transaction.id}`);
      await this.queueService.addPayoutReconciliation({
        payoutTransactionId: transaction.id,
      });
    }
  }
}
