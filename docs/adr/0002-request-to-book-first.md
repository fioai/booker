# ADR 0002: Prefer request-to-book first

- Status: accepted for the initial coexistence mode
- Date: 2026-07-12

## Decision

The initial booking flow is request-to-book: a guest submits a request and an owner
approves it only after a current availability check. Instant booking is not implied by
the bootstrap contracts.

## Rationale

External calendar feeds are eventually consistent and cannot guarantee immediate
cross-channel safety. Owner approval is a bounded operational control while stronger
channel evidence is gathered.

## Consequences

- A request must not silently become a confirmed reservation.
- Payment and confirmation behavior remain deferred until their trust boundaries are
  implemented and tested.
- Any future instant-booking decision must be explicit and evidence-based.
