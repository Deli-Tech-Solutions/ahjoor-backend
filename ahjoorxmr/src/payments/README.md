# Installment pause and penalty accrual

## Product rule

The penalty accrual clock **stops** while an installment plan is paused and
**resumes from where it left off** when the plan is resumed.

## Mechanics

- On pause: record `pausedAtLedger` / `pausedAt`. Settlement and penalty-window
  advancement are blocked for the pause duration.
- On resume: shift `nextDueLedger` and `expiryLedger` forward by the paused
  ledger span; accumulate into `totalPausedLedgers`. Pre-pause lateness is
  preserved; lateness that would have accrued only during the pause is not.
- Effective due across multiple pause/resume cycles is always the stored
  `nextDueLedger` after those shifts. Use `getPenaltyAccrualState` /
  `PaymentsService.getPenaltyAccrualState` — do not invent a parallel clock in
  penalties or trust-score code.

## Abuse limits

- At most `MAX_PAUSES_PER_PLAN` pauses per plan lifetime.
- After resume, `MIN_LEDGERS_BETWEEN_PAUSES` must elapse before the next pause.

## Historical / backfill

Migration `1749100000000` sets `pausedAt` and `pauseCount` for already-paused
plans only. It does **not** invent past pause duration or reverse/credit
existing penalties. Clock-stop applies from deploy forward.

See `installment-pause.constants.ts` for the canonical policy comment and limits.
