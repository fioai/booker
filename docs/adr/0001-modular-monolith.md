# ADR 0001: Use a modular monolith

- Status: accepted for the bootstrap
- Date: 2026-07-12

## Decision

Booking Engine starts as a TypeScript modular monolith backed by PostgreSQL. Domain,
persistence, provider, channel, notification, SDK, and application boundaries are
separate workspace packages, while deployment and runtime composition remain in the
API application.

## Rationale

Rental availability and reservation correctness require transactional coordination.
Keeping the first system in one deployable application makes those boundaries
testable without introducing distributed-systems failure modes. Extraction is a later
operational decision, supported only by evidence from real consumers and workloads.

## Consequences

- Package interfaces protect ownership without pretending that each package is a
  separately deployable service.
- PostgreSQL remains a first-class consistency boundary.
- New packages need a domain or integration ownership reason, not merely a file split.
