# ADR 0005: Keep public consumers behind the API and SDK boundary

- Status: accepted
- Date: 2026-07-12

## Decision

Storefront and admin applications depend on the versioned public API contract through
`@booking-engine/sdk-typescript`. They must not import engine internals, query
PostgreSQL tables, or depend on private server modules. The API may compose internal
engine and adapter packages.

## Rationale

The engine is reusable only when consumers prove their integration through stable
contracts. Direct database or private-module access would couple a consumer to
implementation details and make an external consumer impossible to replace safely.

## Consequences

- Public contracts and SDK types are established before application features.
- Consumer-specific presentation and configuration remain outside engine packages.
- Contract tests will be added against a running API before a real consumer is
  accepted.
