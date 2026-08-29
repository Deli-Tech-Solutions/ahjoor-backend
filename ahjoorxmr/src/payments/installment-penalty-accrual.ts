import { InstallmentPaymentPlan } from './entities/installment-payment-plan.entity';

export interface PenaltyAccrualState {
  /** False while the plan is paused — clock is frozen. */
  accruing: boolean;
  /** Due ledger used for lateness; equals stored nextDueLedger after pause shifts. */
  effectiveDueLedger: number;
  /** Ledgers past effective due; 0 while paused or before due. */
  ledgersLate: number;
  /**
   * Whole penalty windows elapsed since effective due.
   * A window is one `intervalLedgers` period after the due ledger.
   * Always 0 while paused (clock stopped), even if the pause spans multiple
   * what-would-have-been windows.
   */
  completedPenaltyWindows: number;
  /** Fraction of the current window elapsed (0..1), or 0 when not accruing. */
  midWindowProgress: number;
}

/**
 * Single source of truth for installment due / penalty-window math.
 * Relies on `nextDueLedger` already reflecting cumulative pause shifts.
 */
export function getPenaltyAccrualState(
  plan: Pick<
    InstallmentPaymentPlan,
    'nextDueLedger' | 'intervalLedgers' | 'paused' | 'status'
  >,
  currentLedger: number,
): PenaltyAccrualState {
  const effectiveDueLedger = plan.nextDueLedger;
  const interval = Math.max(plan.intervalLedgers, 1);

  if (plan.paused) {
    return {
      accruing: false,
      effectiveDueLedger,
      ledgersLate: 0,
      completedPenaltyWindows: 0,
      midWindowProgress: 0,
    };
  }

  const ledgersLate = Math.max(0, currentLedger - effectiveDueLedger);
  const completedPenaltyWindows = Math.floor(ledgersLate / interval);
  const remainder = ledgersLate % interval;

  return {
    accruing: ledgersLate > 0,
    effectiveDueLedger,
    ledgersLate,
    completedPenaltyWindows,
    midWindowProgress: remainder / interval,
  };
}

/**
 * Ledgers to add to due/expiry when resuming. Preserves pre-pause lateness
 * by shifting the schedule forward by the full pause duration.
 */
export function computePausedLedgers(
  pausedAtLedger: number,
  resumeLedger: number,
): number {
  if (resumeLedger < pausedAtLedger) {
    throw new Error('resumeLedger must be >= pausedAtLedger');
  }
  return resumeLedger - pausedAtLedger;
}
