# ADR 0012: Trust Score Anti-Gaming Signals

## Status

Accepted

## Context

The trust score rewards punctual contributions and completed groups. A user or
coalition could manufacture a low-stakes history, then use the inflated score
in a higher-value group. Anti-gaming signals must be advisory because activity
patterns can also describe legitimate community organizers.

## Decision

We will maintain an anti-gaming confidence score alongside `MemberTrustScore`
and expose flagged records to platform admins for manual review. The signal
does not modify the trust score, block a user, or create a penalty.

The signal strategy is:

- **Collusion graph:** compare each user's group memberships with the other
  members of those groups. Repeated overlap with the same small cohort is a
  collusion indicator; confidence increases with the share of groups containing
  the repeated cohort.
- **Velocity limits:** later work should add time-windowed limits for rapid
  group creation, joining, completion, and score growth. These should contribute
  confidence rather than act as hard thresholds.
- **KYC linkage:** later work should add privacy-preserving linkage signals from
  verified KYC/device identifiers. Raw identifiers must not be exposed in the
  review response, and a linkage match remains evidence for review only.

The first implementation is the collusion-graph repeated-cohort heuristic. It
requires at least three groups, at least three repeated groups, and a confidence
of at least 0.75. The result is stored in `antiGamingConfidence` and
`antiGamingFlagged`, and is surfaced at `GET /admin/trust-score/reviews`.

## Consequences

Admins receive explainable, ranked review candidates without automatic
penalties. The heuristic can produce false positives for organizers, so review
outcomes and an appeal/audit workflow should be added before any future action
is automated. The current batch implementation performs one additional
membership query per recalculation batch, bounded by the groups in that batch.