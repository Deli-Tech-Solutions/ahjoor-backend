import {
  computePausedLedgers,
  getPenaltyAccrualState,
} from './installment-penalty-accrual';
import { InstallmentPlanStatus } from './entities/installment-payment-plan.entity';

describe('installment-penalty-accrual', () => {
  describe('computePausedLedgers', () => {
    it('returns the ledger delta', () => {
      expect(computePausedLedgers(100, 250)).toBe(150);
    });

    it('rejects resume before pause anchor', () => {
      expect(() => computePausedLedgers(200, 100)).toThrow();
    });
  });

  describe('getPenaltyAccrualState', () => {
    const active = {
      nextDueLedger: 1000,
      intervalLedgers: 100,
      paused: false,
      status: InstallmentPlanStatus.ACTIVE,
    };

    it('is not accruing before due', () => {
      const state = getPenaltyAccrualState(active, 999);
      expect(state.accruing).toBe(false);
      expect(state.ledgersLate).toBe(0);
      expect(state.completedPenaltyWindows).toBe(0);
    });

    it('counts full windows after due', () => {
      const state = getPenaltyAccrualState(active, 1300);
      expect(state.completedPenaltyWindows).toBe(3);
      expect(state.midWindowProgress).toBe(0);
    });
  });
});
