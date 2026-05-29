import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InstallmentPaymentPlan,
  InstallmentPlanStatus,
} from './entities/installment-payment-plan.entity';
import { PaymentsService } from './payments.service';
import { StellarService } from '../stellar/stellar.service';
import { User } from '../users/entities/user.entity';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let planRepository: Partial<
    Record<keyof Repository<InstallmentPaymentPlan>, jest.Mock>
  >;
  let stellarService: Partial<Record<keyof StellarService, jest.Mock>>;

  const merchant = {
    id: '75f615ef-bc6e-4484-b6d2-1e9c9402b461',
    walletAddress: 'GMERCHANT',
  } as User;
  const customer = {
    id: 'ec1bc2b0-1670-4965-95e1-11f2b832de19',
    walletAddress: 'GCUSTOMER',
  } as User;

  beforeEach(async () => {
    planRepository = {
      create: jest.fn((input) => ({ id: 'plan-1', ...input })),
      save: jest.fn((input) => Promise.resolve(input)),
      findOne: jest.fn(),
    };
    stellarService = {
      transferFromTokenAllowance: jest.fn().mockResolvedValue('tx-1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: getRepositoryToken(InstallmentPaymentPlan),
          useValue: planRepository,
        },
        {
          provide: StellarService,
          useValue: stellarService,
        },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  async function createPlan(overrides: Partial<InstallmentPaymentPlan> = {}) {
    const plan = await service.createInstallmentPlan(
      merchant,
      customer,
      'CTOKEN',
      '100',
      3,
      5,
      200,
      100,
    );
    return Object.assign(plan, overrides);
  }

  it('stores a per-tranche schedule when creating a plan', async () => {
    const plan = await createPlan();

    expect(plan).toMatchObject({
      merchantId: merchant.id,
      customerId: customer.id,
      token: 'CTOKEN',
      totalAmount: '100',
      numInstallments: 3,
      intervalLedgers: 5,
      nextDueLedger: 105,
      expiryLedger: 200,
      currentInstallment: 0,
      status: InstallmentPlanStatus.ACTIVE,
      paused: false,
      installmentAmounts: ['34', '33', '33'],
    });
  });

  it('settles installments on schedule and completes after the final debit', async () => {
    const plan = await createPlan();
    planRepository.findOne!.mockResolvedValue(plan);
    stellarService.transferFromTokenAllowance!
      .mockResolvedValueOnce('tx-1')
      .mockResolvedValueOnce('tx-2')
      .mockResolvedValueOnce('tx-3');

    await service.settleInstallment('plan-1', 105);
    expect(plan.currentInstallment).toBe(1);
    expect(plan.nextDueLedger).toBe(110);
    expect(plan.status).toBe(InstallmentPlanStatus.ACTIVE);

    await service.settleInstallment('plan-1', 110);
    await service.settleInstallment('plan-1', 115);

    expect(stellarService.transferFromTokenAllowance).toHaveBeenNthCalledWith(
      1,
      'CTOKEN',
      'GCUSTOMER',
      'GMERCHANT',
      '34',
    );
    expect(stellarService.transferFromTokenAllowance).toHaveBeenNthCalledWith(
      3,
      'CTOKEN',
      'GCUSTOMER',
      'GMERCHANT',
      '33',
    );
    expect(plan.currentInstallment).toBe(3);
    expect(plan.status).toBe(InstallmentPlanStatus.COMPLETED);
    expect(plan.settlementTransactionHashes).toEqual(['tx-1', 'tx-2', 'tx-3']);
  });

  it('rejects early settlement with InstallmentNotDue', async () => {
    const plan = await createPlan();
    planRepository.findOne!.mockResolvedValue(plan);

    await expect(service.settleInstallment('plan-1', 104)).rejects.toThrow(
      'InstallmentNotDue',
    );
    expect(stellarService.transferFromTokenAllowance).not.toHaveBeenCalled();
  });

  it('expires a plan and rejects further settlement when expiry ledger is reached', async () => {
    const plan = await createPlan({ expiryLedger: 108 });
    planRepository.findOne!.mockResolvedValue(plan);

    await service.settleInstallment('plan-1', 105);
    await expect(service.settleInstallment('plan-1', 108)).rejects.toThrow(
      'PlanExpired',
    );
    await expect(service.settleInstallment('plan-1', 109)).rejects.toThrow(
      'PlanExpired',
    );

    expect(plan.status).toBe(InstallmentPlanStatus.EXPIRED);
    expect(stellarService.transferFromTokenAllowance).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes plans, rejecting settlement while paused', async () => {
    const plan = await createPlan();
    planRepository.findOne!.mockResolvedValue(plan);

    await service.pausePlan('plan-1');
    expect(plan.status).toBe(InstallmentPlanStatus.PAUSED);
    expect(plan.paused).toBe(true);

    await expect(service.settleInstallment('plan-1', 105)).rejects.toThrow(
      'Plan is paused',
    );

    await service.resumePlan('plan-1');
    expect(plan.status).toBe(InstallmentPlanStatus.ACTIVE);
    expect(plan.paused).toBe(false);

    await service.settleInstallment('plan-1', 105);
    expect(stellarService.transferFromTokenAllowance).toHaveBeenCalledTimes(1);
  });
});
