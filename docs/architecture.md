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
- **`database-postgres`** owns organization-scoped domain SQL, with property scope for
  property-owned records. It also owns PostgreSQL transactions and advisory property locks,
  migration checksums, trusted operational outbox/payment-event repositories, persistence
  corruption classification, and canonical private projections. It never imports the SDK.
- **`channel-ical`** owns iCalendar ports and adapter semantics. PostgreSQL implements its
  adapter but does not re-export its ports.
- **`payments`** owns provider-neutral payment ports. Live Stripe activation is deferred.
- **`apps/api`** owns transport, persistent admin-session authentication, error conversion,
  server-rendered admin presentation, and the sole outward SDK V1 mapper.
- **`sdk-typescript`** owns the stable V1 wire types, OpenAPI metadata, strict response/error
  decoding, and dependency-free consumer client.

## Persistence scope

Tenant-owned domain repository calls include an organization ID. Calls for property-owned data
also include a property ID.

Expired-hold maintenance is the intentional tenant-wide exception to property-targeted repository
calls. `releaseExpiredHolds` accepts organization scope, scans only properties with expired active
holds in that organization, and acquires the organization/property advisory lock before it mutates
holds for each property. An operations caller must not replace this with an unlocked or
cross-organization bulk update.

Trusted operational paths use some global technical keys:

- outbox dispatch claims and acknowledges by `outbox_id`; its internal event retains organization
  and property IDs, and the delivery payload remains private;
- the persistent admin-session repository looks up `session_digest`; it stores no raw session
  token, and use requires active organization membership, an unexpired and unrevoked session, and
  CSRF verification for protected mutations; and
- payment webhook deduplication uses `(provider, provider_event_id)`; trusted ingress verifies the
  signature and provider account, then repository processing checks organization/property
  metadata, checkout identity, amount, currency, and occupancy.

These global keys are for trusted authentication, delivery, and provider-ingress code. They are
not public or tenant-selected lookup keys, and their private data must not cross the public mapper.

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
    scope.ts         tenant/property/request scoping, property lookup, and not-found/error guards
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
5. Public requests persist pending without inventory. In a deployment that activates external
   calendars, the approval procedure must first complete a current successful refresh or another
   authoritative check. Stale or needs-review state blocks approval. The approval transaction
   then rechecks native availability and active iCalendar blocks and inserts occupancy atomically;
   a repaired phantom legacy hold is treated as a public pending request.
6. Legacy pre-010 fingerprints are explicitly marked `legacy-md5-request-id`. Equal normalized
   retries upgrade to `sha256-v1` in the transaction; changed data remains an idempotency-key
   conflict.
7. Stored request arrival/departure must match the quote snapshot or the row is classified as
   `database_corruption`.
8. Public dates are half-open local calendar dates. Money is safe non-negative integer minor
   units. Tenant-owned domain keys and queries include organization scope and property scope where
   applicable; trusted global operational keys follow the restrictions above.

## Persistence and migrations

Repositories live under `packages/database-postgres/src/{organization,property,availability,rates,booking,ical,owner,payment}`.
Shared PostgreSQL plumbing lives under `src/database/`.

Migration SQL in `packages/database-postgres/migrations/` is append-only and listed explicitly in
`database/migrations.ts`. Each applied migration stores a SHA-256 checksum in
`schema_migrations`; old rows with a null checksum are baselined once, then mismatches fail
closed with `MigrationDriftError`. Migration execution uses a schema advisory lock and remains
concurrent-safe/idempotent.

The current `booking_outbox` foreign key uses `ON DELETE CASCADE` from `booking_requests`.
Deleting a booking request therefore deletes its linked outbox rows. A retention procedure must
copy every required audit record to an approved independent retention store before it deletes the
request; the outbox is not an audit copy that survives request deletion.

## Verification boundaries

PostgreSQL integration and Docker clean-room checks are mandatory release gates in the
authoritative root [release checklist](../README.md#development-and-release-gates) and CI. The
release needs the real PostgreSQL service and a running Docker engine. An unavailable service or
engine blocks the release; mocked evidence does not replace either gate.

The local `corepack pnpm scan:secrets` command scans tracked worktree files, non-ignored untracked
files, and staged index snapshots. Ignored secret-bearing files require separate inspection.
Git-history scanning uses `corepack pnpm scan:history`; run it before public release and after any
suspected leak. Revoke or rotate every exposed credential, and purge or rewrite history where
required. Rewriting history does not replace credential revocation or rotation.

## External storefront integration

A storefront installs `@booking-engine/sdk-typescript`, creates a V1 client with an API base URL,
and calls the four supported operations: public property, availability, quote, and
request-to-book. It injects browser/Node fetch only when needed. It handles
`BookingEngineApiErrorV1` by stable code/status and does not depend on repository or admin
classes.

The SDK decoder rejects malformed or privacy-expanding payloads rather than guessing. The API
route paths, status handling, error codes/messages, idempotency header, pending acknowledgement,
local-date semantics, minor-unit money, and omitted private fields are stable V1 contract facts.
