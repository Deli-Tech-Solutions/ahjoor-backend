import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstallmentPaymentPlan } from './entities/installment-payment-plan.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [TypeOrmModule.forFeature([InstallmentPaymentPlan]), StellarModule],
  providers: [PaymentsService],
  controllers: [PaymentsController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
