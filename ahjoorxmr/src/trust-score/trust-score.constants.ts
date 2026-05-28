/**
 * Deterministic scoring formula constants for the Cross-Group Member Trust Score.
 *
 * Formula:
 *   base        = (onTimeContributions / totalContributions) × ON_TIME_WEIGHT
 *   penalty_adj = (penaltiesIncurred − penaltiesPaid) × PENALTY_DEDUCTION  (floor 0)
 *   completion  = groupsCompletedSuccessfully × COMPLETION_BONUS_PER_GROUP  (cap COMPLETION_BONUS_CAP)
 *   score       = clamp(base − penalty_adj + completion, 0, 100)
 */
export const TRUST_SCORE_FORMULA = {
  /** Weight applied to the on-time contribution ratio (0–1). */
  ON_TIME_WEIGHT: 60,

  /** Points deducted per outstanding (unpaid) penalty. */
  PENALTY_DEDUCTION: 5,

  /** Points added per successfully completed group. */
  COMPLETION_BONUS_PER_GROUP: 4,

  /** Maximum points that can be earned from the completion bonus. */
  COMPLETION_BONUS_CAP: 20,

  /** Minimum possible score. */
  SCORE_MIN: 0,

  /** Maximum possible score. */
  SCORE_MAX: 100,
} as const;

/** Number of users processed per batch tick in the nightly recalculation job. */
export const TRUST_SCORE_BATCH_SIZE = 200;
