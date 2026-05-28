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
    private readonly stellarService: StellarService,
    private readonly notificationsService: NotificationsService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
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

    const payoutTransaction = this.payoutTransactionRepository.create({
      payoutOrderId,
      status: PayoutTransactionStatus.PENDING_SUBMISSION,
      txHash: null,
    });
    await this.payoutTransactionRepository.save(payoutTransaction);

    let txHash: string;
    try {
      txHash = await this.stellarService.disbursePayout(
        group.contractAddress,
        recipient.walletAddress,
        group.contributionAmount,
        async (calculatedHash: string) => {
          payoutTransaction.txHash = calculatedHash;
          await this.payoutTransactionRepository.save(payoutTransaction);
        }
      );

      payoutTransaction.txHash = txHash;

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
