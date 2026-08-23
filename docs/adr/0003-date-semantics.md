# ADR 0003: Model stays as half-open local-date intervals

- Status: accepted
- Date: 2026-07-12

## Decision

Stay dates use property-local calendar dates and the half-open interval `[arrival,
departure)`. Arrival is occupying; departure is non-occupying. A valid stay has an
arrival strictly before its departure.

## Rationale

Half-open intervals make adjacent stays unambiguous: one stay departing on a date does
not overlap another arriving on that same date. Property timezone and calendar-date
semantics must remain explicit rather than inferred from a browser or server timezone.

## Consequences

- Future availability and database constraints must preserve the same interval rule.
- DST and timestamp normalization require focused tests when executable date behavior
  is added.
- This bootstrap records the invariant but does not implement booking logic.
