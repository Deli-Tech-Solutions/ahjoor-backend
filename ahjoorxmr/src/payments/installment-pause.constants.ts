/**
 * Installment pause ↔ penalty accrual policy
 * ==========================================
 *
 * Product rule (source of truth):
 *   The penalty accrual clock STOPS while an installment plan is paused and
 *   RESUMES from where it left off when the plan is resumed.
 *
 * Mechanics:
 *   - On pause: record `pausedAtLedger` / `pausedAt`. Settlement and penalty
 *     window advancement are blocked for the duration of the pause.
 *   - On resume: shift `nextDueLedger` and `expiryLedger` forward by the number
 *     of ledgers that elapsed while paused, and accumulate that duration into
 *     `totalPausedLedgers`. Lateness that existed at pause time is preserved;
 *     lateness that would have accrued only during the pause is discarded.
 *   - Effective due date across N pause/resume cycles is always the stored
 *     `nextDueLedger` after those shifts — callers must not invent a parallel clock.
 *
 * Abuse prevention:
 *   - A plan may be paused at most MAX_PAUSES_PER_PLAN times.
 *   - After a resume, MIN_LEDGERS_BETWEEN_PAUSES must elapse before the next pause.
 *
 * Historical / backfill:
 *   Plans already paused under the previous (undefined) behavior get
 *   `pausedAt = updatedAt` and `pauseCount = 1` at migrate time. We do NOT
 *   invent past pause duration, reverse existing penalties, or credit members
 *   retroactively. Clock-stop applies from deploy forward.
 */

/** Maximum number of pause cycles allowed over the life of a plan. */
export const MAX_PAUSES_PER_PLAN = 3;

/**
 * Minimum ledgers that must elapse after a resume before the plan may be
 * paused again. Prevents rapid pause/resume cycling to dodge penalties.
 */
export const MIN_LEDGERS_BETWEEN_PAUSES = 100;
