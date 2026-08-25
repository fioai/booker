# Architecture map

## Runtime shape

The repository is one modular monolith. `apps/api/src/http/server.ts` is the only listener
composition root. It mounts public booking routes, optional same-origin owner admin routes,
optional internal payment HTTP, the OpenAPI document, and `/healthz` on one listener.

The deployment boundary is intentionally boring: PostgreSQL is the consistency boundary, and
`apps/api` composes concrete repositories and adapters. No service split or generic shared
package is planned for the first release.

## Dependency direction

```text
channel-ical -> channel-calendar
payments-stripe -> payments
database-postgres -> booking-core, payments, channel-ical
apps/api -> booking-core, database-postgres, channel-ical, payments, sdk-typescript
```

The SDK has no workspace or runtime dependencies. `notifications`, `channel-calendar`,
`booking-core`, `payments`, and `test-support` do not depend on other workspace packages.
Composite TypeScript references mirror runtime workspace dependencies and are checked by
`pnpm check:architecture`.

## Package ownership

- **`booking-core`** owns property configuration brands and invariants, half-open local-date
  intervals, minor-unit money, rate plans/quotes, and booking lifecycle transitions.
- **`database-postgres`** owns tenant-scoped SQL, PostgreSQL transactions and advisory property
  locks, migration checksums, persistence corruption classification, and canonical private
  projections. It never imports the SDK.
- **`channel-ical`** owns iCalendar ports and adapter semantics. PostgreSQL implements its
  adapter but does not re-export its ports.
- **`payments`** owns provider-neutral payment ports. Live Stripe activation is deferred.
- **`apps/api`** owns transport, error conversion, server-rendered admin presentation, and the
  sole outward SDK V1 mapper.
- **`sdk-typescript`** owns the stable V1 wire types, OpenAPI metadata, strict response/error
  decoding, and dependency-free consumer client.

## API layout

```text
apps/api/src/
  http/
    body.ts       bounded JSON/form/raw-body readers
    response.ts   JSON/admin writers and safe internal error body
    server.ts     createApiHttpServer composition root
  public/booking/
    contracts.ts     public API types and error class
    routes.ts        V1 route parsing and idempotency header extraction
    errors.ts        persistence-to-public error conversion
    serialization.ts non-property public serializers
    api.ts            createPublicBookingApi/HttpApi orchestration
  admin/
    contracts.ts     admin API types and error class
    routes.ts        route union/parser
    security.ts      cookies, CSRF, origin, bounded bodies, sessions, roles
    validation.ts    property/rate/manual-block input validation
    serialization.ts response/error serializers and safe health output
    views/property-page.ts server-rendered reference property page
    api.ts            createAdminHttpApi dispatch owner
```

The unified server is the only binding. `apps/admin` is intentionally absent.

## Canonical ownership and privacy

PostgreSQL `public_properties` is a privacy-minimized SQL view. The repository validates its
rows into a canonical `PropertyConfiguration` using an internal operational-notes sentinel.
`apps/api/src/property/configuration/mapper.ts` checks the canonical brand and copies only the
SDK V1 allowlist. Public responses never contain operational notes, guest contact data,
organization identifiers, idempotency keys, hold identifiers, or request fingerprints.

Public request responses contain the nested quote snapshot but no guest PII. Admin serializers
are separate and authenticated; they may expose private fields only inside the same-origin
owner-admin scope.

## Request lifecycle invariants

1. Public request-to-book validates a bounded local-date interval and guest input before I/O.
2. The required `Idempotency-Key` is separate from the JSON body.
3. A quote is validated as an immutable snapshot; nightly dates/count and arithmetic must agree.
4. Property availability-affecting decisions acquire the tenant/property advisory lock.
5. Public requests persist pending without inventory. Owner approval rechecks availability and
   inserts occupancy atomically; a repaired phantom legacy hold is treated as a public pending
   request.
6. Legacy pre-010 fingerprints are explicitly marked `legacy-md5-request-id`. Equal normalized
   retries upgrade to `sha256-v1` in the transaction; changed data remains an idempotency-key
   conflict.
7. Stored request arrival/departure must match the quote snapshot or the row is classified as
   `database_corruption`.
8. Public dates are half-open local calendar dates. Money is safe non-negative integer minor
   units. Tenant scope is part of every persistence key and query.

## Persistence and migrations

Repositories live under `packages/database-postgres/src/{organization,property,availability,rates,booking,ical,owner,payment}`.
Shared PostgreSQL plumbing lives under `src/database/`.

Migration SQL in `packages/database-postgres/migrations/` is append-only and listed explicitly in
`database/migrations.ts`. Each applied migration stores a SHA-256 checksum in
`schema_migrations`; old rows with a null checksum are baselined once, then mismatches fail
closed with `MigrationDriftError`. Migration execution uses a schema advisory lock and remains
concurrent-safe/idempotent.

## External storefront integration

A storefront installs `@booking-engine/sdk-typescript`, creates a V1 client with an API base URL,
and calls the four supported operations: public property, availability, quote, and
request-to-book. It injects browser/Node fetch only when needed. It handles
`BookingEngineApiErrorV1` by stable code/status and does not depend on repository or admin
classes.

The SDK decoder rejects malformed or privacy-expanding payloads rather than guessing. The API
route paths, status handling, error codes/messages, idempotency header, pending acknowledgement,
local-date semantics, minor-unit money, and omitted private fields are stable V1 contract facts.
