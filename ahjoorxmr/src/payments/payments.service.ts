import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstallmentPaymentPlan, InstallmentPlanStatus } from './entities/installment-payment-plan.entity';
import { User } from '../users/entities/user.entity';
import { StellarService } from '../stellar/stellar.service';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(InstallmentPaymentPlan)
    private readonly planRepo: Repository<InstallmentPaymentPlan>,
    private readonly stellarService: StellarService,
  ) {}

  async createInstallmentPlan(
    merchant: User,
    customer: User,
    token: string,
    totalAmount: string,
    numInstallments: number,
    intervalLedgers: number,
    expiryLedger: number,
    currentLedger = 0,
  ): Promise<InstallmentPaymentPlan> {
    if (!merchant?.id) throw new BadRequestException('merchant is required');
    if (!customer?.id) throw new BadRequestException('customer is required');
    if (!token) throw new BadRequestException('token is required');
    if (numInstallments < 1) {
      throw new BadRequestException('numInstallments must be >= 1');
    }
    if (intervalLedgers < 1) {
      throw new BadRequestException('intervalLedgers must be >= 1');
    }

    const total = BigInt(totalAmount);
    if (total <= 0n) throw new BadRequestException('totalAmount must be > 0');

    const nextDueLedger = currentLedger + intervalLedgers;
    if (expiryLedger < nextDueLedger) {
      throw new BadRequestException('expiryLedger must be after the first due ledger');
    }

    const baseAmount = total / BigInt(numInstallments);
    const remainder = Number(total % BigInt(numInstallments));
    const amounts = Array.from({ length: numInstallments }, (_, index) =>
      (baseAmount + (index < remainder ? 1n : 0n)).toString(),
    );

    const plan = this.planRepo.create({
      merchant,
      merchantId: merchant.id,
      customer,
      customerId: customer.id,
      token,
      totalAmount,
      numInstallments,
      intervalLedgers,
      expiryLedger,
      currentInstallment: 0,
      nextDueLedger,
      status: InstallmentPlanStatus.ACTIVE,
      installmentAmounts: amounts,
      paused: false,
      settlementTransactionHashes: [],
      lastSettledAmount: null,
    });
    return this.planRepo.save(plan);
  }

  async settleInstallment(planId: string, currentLedger: number): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({
      where: { id: planId },
      relations: { customer: true, merchant: true },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    if (plan.status === InstallmentPlanStatus.EXPIRED) {
      throw new BadRequestException('PlanExpired');
    }
    if (plan.status === InstallmentPlanStatus.COMPLETED) {
      throw new BadRequestException('Plan already completed');
    }
    if (plan.paused || plan.status === InstallmentPlanStatus.PAUSED) {
      throw new BadRequestException('Plan is paused');
    }
    if (currentLedger >= plan.expiryLedger) {
      plan.status = InstallmentPlanStatus.EXPIRED;
      await this.planRepo.save(plan);
      throw new BadRequestException('PlanExpired');
    }
    if (plan.status !== InstallmentPlanStatus.ACTIVE) {
      throw new BadRequestException('Plan not active');
    }
    if (currentLedger < plan.nextDueLedger) {
      throw new BadRequestException('InstallmentNotDue');
    }
    if (plan.currentInstallment >= plan.numInstallments) {
      throw new BadRequestException('Plan already completed');
    }

    const amount = plan.installmentAmounts[plan.currentInstallment];
    const txHash = await this.stellarService.transferFromTokenAllowance(
      plan.token,
      plan.customer.walletAddress,
      plan.merchant.walletAddress,
      amount,
    );

    plan.currentInstallment++;
    plan.lastSettledAmount = amount;
    plan.settlementTransactionHashes = [
      ...(plan.settlementTransactionHashes ?? []),
      txHash,
    ];

    if (plan.currentInstallment >= plan.numInstallments) {
      plan.status = InstallmentPlanStatus.COMPLETED;
    } else {
      plan.nextDueLedger += plan.intervalLedgers;
    }
    return this.planRepo.save(plan);
  }

  async pausePlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status === InstallmentPlanStatus.COMPLETED) {
      throw new BadRequestException('Plan already completed');
    }
    if (plan.status === InstallmentPlanStatus.EXPIRED) {
      throw new BadRequestException('PlanExpired');
    }
    plan.paused = true;
    plan.status = InstallmentPlanStatus.PAUSED;
    return this.planRepo.save(plan);
  }

  async resumePlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== InstallmentPlanStatus.PAUSED) {
      throw new BadRequestException('Plan is not paused');
    }
    plan.paused = false;
    plan.status = InstallmentPlanStatus.ACTIVE;
    return this.planRepo.save(plan);
  }

  async getPlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }
}
