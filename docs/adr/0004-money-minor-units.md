# ADR 0004: Represent money in integer minor units

- Status: accepted
- Date: 2026-07-12

## Decision

Monetary amounts use integer minor units together with an explicit ISO currency code.
Binary floating-point values are not a money representation.

## Rationale

Integer minor units make arithmetic, comparison, persistence, and provider amount
verification deterministic. Currency is part of the value and must not be inferred
from a display locale.

## Consequences

- Future quote and payment contracts must carry amount and currency together.
- Rounding rules belong to an explicit pricing policy, not to UI formatting.
- The bootstrap exports only a provider-neutral type contract; it does not calculate
  prices.
