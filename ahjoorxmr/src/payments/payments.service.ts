import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstallmentPaymentPlan, InstallmentPlanStatus } from './entities/installment-payment-plan.entity';
import { User } from '../users/entities/user.entity';

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

  async pausePlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    plan.paused = true;
    plan.status = InstallmentPlanStatus.PAUSED;
    return this.planRepo.save(plan);
  }

  async resumePlan(planId: string): Promise<InstallmentPaymentPlan> {
    const plan = await this.planRepo.findOne({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
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
