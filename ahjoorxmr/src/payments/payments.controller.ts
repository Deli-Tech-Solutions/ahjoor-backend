import { Controller, Post, Body, Param, Patch, Get, Query } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { InstallmentPaymentPlan } from './entities/installment-payment-plan.entity';

@Controller('payments/installments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('create')
  async createPlan(@Body() body: any): Promise<InstallmentPaymentPlan> {
    // TODO: Add DTO and validation
    return this.paymentsService.createInstallmentPlan(
      body.merchant,
      body.customer,
      body.token,
      body.totalAmount,
      body.numInstallments,
      body.intervalLedgers,
      body.expiryLedger,
      body.currentLedger ?? 0,
    );
  }

  @Patch(':id/settle')
  async settle(@Param('id') id: string, @Body('currentLedger') currentLedger: number) {
    return this.paymentsService.settleInstallment(id, currentLedger);
  }

  @Patch(':id/pause')
  async pause(@Param('id') id: string) {
    return this.paymentsService.pausePlan(id);
  }

  @Patch(':id/resume')
  async resume(@Param('id') id: string) {
    return this.paymentsService.resumePlan(id);
  }

  @Get(':id')
  async getPlan(@Param('id') id: string) {
    return this.paymentsService.getPlan(id);
  }
}
