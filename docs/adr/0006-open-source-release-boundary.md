# ADR 0006: Open-source release boundary

- Status: accepted
- Date: 2026-08-25

## Decision

The first open-source release keeps the deployment as one modular monolith. We will not
introduce a service split or a new generic `common`, `kernel`, or `booking-application`
package.

`@booking-engine/sdk-typescript` is the only intended first-release public package. Version `0.1.0`
is an unpublished release candidate; publish it only after the annotated `v0.1.0` tag and registry
publication with provenance. The package has no workspace dependencies. `booking-core`,
`database-postgres`, `payments`, `payments-stripe`, `channel-calendar`, `channel-ical`,
`notifications`, and `test-support` remain private implementation or test packages.

The owner admin is a same-origin, server-rendered reference surface owned by `apps/api`.
External consumers use the public SDK and never import admin, database, or domain internals.

The repository is licensed under MIT. The current runtime intentionally does not activate
live Stripe payments, notification transport, or background scheduling.

## Package graph

The intended workspace edges are:

- `channel-ical -> channel-calendar`;
- `payments-stripe -> payments`;
- `database-postgres -> booking-core, payments, channel-ical`;
- `apps/api -> booking-core, database-postgres, channel-ical, payments, sdk-typescript`.

The SDK, core, calendar, payments, notifications, and test-support packages have no other
runtime workspace dependencies.

## Consequences

- `apps/api` remains the internal composition layer and keeps its intentional PostgreSQL
  dependency for this release.
- Persistence owns scoped, privacy-minimized canonical projections; `apps/api` owns SDK V1
  serialization.
- Internal package renames and removal of unused compatibility exports are breaking changes
  inside an unreleased workspace; no aliases are retained.
- Live payment activation, notification delivery, and worker/scheduler behavior remain
  explicit future boundaries rather than implied features.
