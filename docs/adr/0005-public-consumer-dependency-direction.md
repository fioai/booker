# ADR 0005: Keep public consumers behind the API and SDK boundary

- Status: accepted
- Date: 2026-07-12

> **Current boundary:** This ADR is maintained for the open-source modular-monolith release.
> The old standalone `apps/admin` package no longer exists. The owner admin is a same-origin,
> server-rendered reference surface in `apps/api`.

## Decision

External storefronts depend on the versioned public HTTP contract through
`@booking-engine/sdk-typescript`. They must not import engine internals, query PostgreSQL
tables, or depend on private server modules. `apps/api` may compose internal domain,
persistence, calendar, and payment packages.

The first public package is the dependency-free SDK at `0.1.x`. The owner admin remains an
internal server-rendered surface; it is not a browser-admin SDK or a second public package.

## Rationale

The engine is reusable only when consumers prove their integration through stable contracts.
Direct database or private-module access couples a consumer to implementation details and makes
an external storefront impossible to replace safely.

## Consequences

- Public contracts and SDK types are established before application features.
- Consumer-specific presentation and configuration remain outside engine packages.
- Persistence returns canonical domain projections; the API owns SDK serialization and privacy
  allowlists.
- Live payment activation, notification delivery, and background scheduling remain deferred
  runtime boundaries.
- Contract tests run against the actual API surface; repository unit tests do not create a
  second consumer contract.
