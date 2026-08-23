import {
  Injectable,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InstallmentPaymentPlan,
  InstallmentPlanStatus,
} from './entities/installment-payment-plan.entity';
import { User } from '../users/entities/user.entity';
import {
  MAX_PAUSES_PER_PLAN,
  MIN_LEDGERS_BETWEEN_PAUSES,
} from './installment-pause.constants';
import {
  computePausedLedgers,
  getPenaltyAccrualState,
  PenaltyAccrualState,
} from './installment-penalty-accrual';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(InstallmentPaymentPlan)
    private readonly planRepo: Repository<InstallmentPaymentPlan>,
  ) {}

  async createInstallmentPlan(
    merchant: User,
    customer: User,
    token: string,
    totalAmount: string,
    numInstallments: number,
    intervalLedgers: number,
    expiryLedger: number,
  ): Promise<InstallmentPaymentPlan> {
    if (numInstallments < 1) throw new BadRequestException('numInstallments must be >= 1');
    const perInstallment = (BigInt(totalAmount) / BigInt(numInstallments)).toString();
    const amounts = Array(numInstallments).fill(perInstallment);
    const plan = this.planRepo.create({
      merchant,
      customer,
      token,
      totalAmount,
      numInstallments,
      intervalLedgers,
      expiryLedger,
      currentInstallment: 0,
      nextDueLedger: 0, // Should be set to current ledger + intervalLedgers
      status: InstallmentPlanStatus.ACTIVE,
      installmentAmounts: amounts,
      paused: false,
      pausedAtLedger: null,
      pausedAt: null,
      totalPausedLedgers: 0,
      pauseCount: 0,
      lastResumedAtLedger: null,
    });
    return this.planRepo.save(plan);
  }

  async settleInstallment(planId: string, currentLedger: number): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== InstallmentPlanStatus.ACTIVE) throw new BadRequestException('Plan not active');
    if (plan.paused) throw new BadRequestException('Plan is paused');
    if (currentLedger < plan.nextDueLedger) throw new BadRequestException('InstallmentNotDue');
    if (plan.currentInstallment >= plan.numInstallments) throw new BadRequestException('Plan already completed');
    if (currentLedger > plan.expiryLedger) {
      plan.status = InstallmentPlanStatus.EXPIRED;
      await this.planRepo.save(plan);
      throw new BadRequestException('PlanExpired');
    }
    // TODO: Call token::transfer_from logic here
    plan.currentInstallment++;
    if (plan.currentInstallment >= plan.numInstallments) {
      plan.status = InstallmentPlanStatus.COMPLETED;
    } else {
      plan.nextDueLedger += plan.intervalLedgers;
    }
    return this.planRepo.save(plan);
  }

  /**
   * Pause the plan and freeze the penalty accrual clock.
   * Requires `currentLedger` so cooldown and pause anchors are ledger-accurate.
   */
  async pausePlan(planId: string, currentLedger: number): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== InstallmentPlanStatus.ACTIVE || plan.paused) {
      throw new BadRequestException('Plan cannot be paused');
    }
    if (plan.pauseCount >= MAX_PAUSES_PER_PLAN) {
      throw new BadRequestException(
        `Pause limit reached (max ${MAX_PAUSES_PER_PLAN} pauses per plan)`,
      );
    }
    if (
      plan.lastResumedAtLedger != null &&
      currentLedger - plan.lastResumedAtLedger < MIN_LEDGERS_BETWEEN_PAUSES
    ) {
      const remaining =
        MIN_LEDGERS_BETWEEN_PAUSES - (currentLedger - plan.lastResumedAtLedger);
      throw new HttpException(
        `Pause cooldown active; wait ${remaining} more ledger(s)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    plan.paused = true;
    plan.status = InstallmentPlanStatus.PAUSED;
    plan.pausedAtLedger = currentLedger;
    plan.pausedAt = new Date();
    plan.pauseCount += 1;
    return this.planRepo.save(plan);
  }

  /**
   * Resume the plan and shift due/expiry ledgers by the paused duration so
   * penalty accrual continues from the same relative lateness as at pause time.
   */
  async resumePlan(planId: string, currentLedger: number): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== InstallmentPlanStatus.PAUSED || !plan.paused) {
      throw new BadRequestException('Plan is not paused');
    }
    // Backfilled pauses may lack pausedAtLedger (unknown under old behavior).
    // Treat resume ledger as the anchor so we do not invent historical duration
    // or unfairly shift due dates — clock-stop applies from this resume forward.
    if (plan.pausedAtLedger == null) {
      plan.pausedAtLedger = currentLedger;
    }
    if (currentLedger < plan.pausedAtLedger) {
      throw new BadRequestException('currentLedger must be >= pausedAtLedger');
    }

    const pausedLedgers = computePausedLedgers(plan.pausedAtLedger, currentLedger);
    plan.nextDueLedger += pausedLedgers;
    plan.expiryLedger += pausedLedgers;
    plan.totalPausedLedgers += pausedLedgers;
    plan.paused = false;
    plan.status = InstallmentPlanStatus.ACTIVE;
    plan.pausedAtLedger = null;
    plan.pausedAt = null;
    plan.lastResumedAtLedger = currentLedger;
    return this.planRepo.save(plan);
  }

  async getPlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  /**
   * Penalty accrual view for a plan at `currentLedger`.
   * While paused, `accruing` is false and windows do not advance.
   */
  async getPenaltyAccrualState(
    planId: string,
    currentLedger: number,
  ): Promise<PenaltyAccrualState> {
    const plan = await this.getPlan(planId);
    return getPenaltyAccrualState(plan, currentLedger);
  }
}
