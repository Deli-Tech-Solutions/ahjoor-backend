import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, HttpException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import {
  InstallmentPaymentPlan,
  InstallmentPlanStatus,
} from './entities/installment-payment-plan.entity';
import {
  MAX_PAUSES_PER_PLAN,
  MIN_LEDGERS_BETWEEN_PAUSES,
} from './installment-pause.constants';
import { getPenaltyAccrualState } from './installment-penalty-accrual';

describe('PaymentsService pause / penalty accrual', () => {
  let service: PaymentsService;
  let saved: InstallmentPaymentPlan;

  const basePlan = (): InstallmentPaymentPlan =>
    ({
      id: 'plan-1',
      nextDueLedger: 1000,
      expiryLedger: 5000,
      intervalLedgers: 100,
      currentInstallment: 0,
      numInstallments: 5,
      status: InstallmentPlanStatus.ACTIVE,
      paused: false,
      pausedAtLedger: null,
      pausedAt: null,
      totalPausedLedgers: 0,
      pauseCount: 0,
      lastResumedAtLedger: null,
    }) as InstallmentPaymentPlan;

  beforeEach(async () => {
    saved = basePlan();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: getRepositoryToken(InstallmentPaymentPlan),
          useValue: {
            findOne: jest.fn(async () => saved),
            save: jest.fn(async (plan: InstallmentPaymentPlan) => {
              saved = { ...plan };
              return saved;
            }),
            create: jest.fn((data) => data),
          },
        },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  describe('getPenaltyAccrualState (helper)', () => {
    it('stops accrual while paused even if pause spans multiple windows', () => {
      const plan = {
        ...basePlan(),
        paused: true,
        status: InstallmentPlanStatus.PAUSED,
        nextDueLedger: 1000,
        intervalLedgers: 100,
      };

      // Without clock-stop, ledger 1350 would be 3.5 windows late
      const state = getPenaltyAccrualState(plan, 1350);

      expect(state.accruing).toBe(false);
      expect(state.ledgersLate).toBe(0);
      expect(state.completedPenaltyWindows).toBe(0);
      expect(state.midWindowProgress).toBe(0);
    });

    it('reports mid-window progress when active and late', () => {
      const plan = basePlan();
      const state = getPenaltyAccrualState(plan, 1150); // 1.5 windows late

      expect(state.accruing).toBe(true);
      expect(state.ledgersLate).toBe(150);
      expect(state.completedPenaltyWindows).toBe(1);
      expect(state.midWindowProgress).toBe(0.5);
    });
  });

  describe('pause spanning multiple penalty windows then resume', () => {
    it('shifts due by full pause duration so lateness matches pre-pause', async () => {
      // Late by 50 ledgers (mid first window) at pause
      saved.nextDueLedger = 1000;
      await service.pausePlan('plan-1', 1050);

      expect(saved.status).toBe(InstallmentPlanStatus.PAUSED);
      expect(saved.pausedAtLedger).toBe(1050);
      expect(saved.pauseCount).toBe(1);

      // Pause spans ledgers 1050 → 1400 (3.5 would-be windows past original due)
      await service.resumePlan('plan-1', 1400);

      expect(saved.status).toBe(InstallmentPlanStatus.ACTIVE);
      expect(saved.paused).toBe(false);
      // 350 ledgers paused → due/expiry shifted forward
      expect(saved.nextDueLedger).toBe(1350);
      expect(saved.expiryLedger).toBe(5350);
      expect(saved.totalPausedLedgers).toBe(350);
      expect(saved.lastResumedAtLedger).toBe(1400);

      // At resume ledger, still exactly 50 late — same as at pause
      const state = getPenaltyAccrualState(saved, 1400);
      expect(state.ledgersLate).toBe(50);
      expect(state.completedPenaltyWindows).toBe(0);
      expect(state.midWindowProgress).toBe(0.5);
    });

    it('accumulates shifts across multiple pause/resume cycles', async () => {
      saved.nextDueLedger = 1000;
      saved.expiryLedger = 5000;

      await service.pausePlan('plan-1', 1000);
      await service.resumePlan('plan-1', 1100); // +100
      expect(saved.nextDueLedger).toBe(1100);
      expect(saved.totalPausedLedgers).toBe(100);

      // Satisfy cooldown
      saved.lastResumedAtLedger = 1100 - MIN_LEDGERS_BETWEEN_PAUSES;

      await service.pausePlan('plan-1', 1200);
      await service.resumePlan('plan-1', 1350); // +150
      expect(saved.nextDueLedger).toBe(1250);
      expect(saved.totalPausedLedgers).toBe(250);
      expect(saved.pauseCount).toBe(2);
    });
  });

  describe('resume mid-penalty-window', () => {
    it('preserves mid-window lateness after resume', async () => {
      saved.nextDueLedger = 1000;
      // Pause mid-window (60% through first late window)
      await service.pausePlan('plan-1', 1060);
      await service.resumePlan('plan-1', 1160);

      expect(saved.nextDueLedger).toBe(1100);
      const state = getPenaltyAccrualState(saved, 1160);
      expect(state.accruing).toBe(true);
      expect(state.ledgersLate).toBe(60);
      expect(state.completedPenaltyWindows).toBe(0);
      expect(state.midWindowProgress).toBe(0.6);
    });
  });

  describe('pause cooldown and limits', () => {
    it('rejects pause during cooldown after resume', async () => {
      await service.pausePlan('plan-1', 1000);
      await service.resumePlan('plan-1', 1050);

      await expect(service.pausePlan('plan-1', 1050 + 10)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('allows pause after cooldown elapses', async () => {
      await service.pausePlan('plan-1', 1000);
      await service.resumePlan('plan-1', 1050);

      const afterCooldown = 1050 + MIN_LEDGERS_BETWEEN_PAUSES;
      await expect(service.pausePlan('plan-1', afterCooldown)).resolves.toBeDefined();
      expect(saved.pauseCount).toBe(2);
    });

    it('rejects pause after MAX_PAUSES_PER_PLAN', async () => {
      for (let i = 0; i < MAX_PAUSES_PER_PLAN; i++) {
        saved.status = InstallmentPlanStatus.ACTIVE;
        saved.paused = false;
        saved.pausedAtLedger = null;
        saved.lastResumedAtLedger =
          i === 0 ? null : 2000 + i * MIN_LEDGERS_BETWEEN_PAUSES;
        await service.pausePlan('plan-1', 3000 + i * MIN_LEDGERS_BETWEEN_PAUSES);
        if (i < MAX_PAUSES_PER_PLAN - 1) {
          await service.resumePlan(
            'plan-1',
            3000 + i * MIN_LEDGERS_BETWEEN_PAUSES + 10,
          );
        }
      }

      saved.status = InstallmentPlanStatus.ACTIVE;
      saved.paused = false;
      saved.pausedAtLedger = null;
      saved.lastResumedAtLedger = 99999;

      await expect(service.pausePlan('plan-1', 100000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('settle while paused', () => {
    it('still rejects settlement', async () => {
      await service.pausePlan('plan-1', 1000);
      await expect(service.settleInstallment('plan-1', 2000)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
