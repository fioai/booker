# Self-host deployment

> **Current guide:** This document describes the present pre-release modular-monolith runtime.
> The [README release checklist](../../README.md#development-and-release-gates) is the single
> authoritative release command list. The CI workflow and root scripts implement its checks; they
> do not define a second command list. Dated verification notes are supporting historical evidence
> only.

The container builds the workspace from the frozen lockfile, compiles `apps/api` and private
workspace packages, runs idempotent migrations on startup, and serves public booking plus
same-origin server-rendered owner admin on one listener. `scripts/migrate.mjs` remains the safe
explicit migration command for release rehearsals. There is no separate migration job in this
slice.

Live Stripe activation, notification delivery, background scheduling, expiry workers, outbox
delivery, and background iCalendar synchronization are not active runtime features. Configure
those as deployment-owned future boundaries rather than assuming they run in this image.

## Host development flow

Use this flow only when the API must run on the host. The seeded example is provided by the
Compose app in the root [Quickstart](../../README.md#quickstart). Create `.env` with the
platform-specific Quickstart command. Stop the Compose app before you start the host API. There
must be only one API writer.

Reuse the PostgreSQL database, user, and password that initialized the current Compose volume.
`POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are initialization variables. Changing
them does not modify an existing PostgreSQL volume. New values require a new Compose project and
volume, or an explicit PostgreSQL data and role migration. Do not use new initialization values
with an unchanged volume.

Set `POSTGRES_PORT` for the port that PostgreSQL publishes to the host. Decode `DATABASE_URL` with
a secret-safe configuration tool. Verify that its host is `127.0.0.1`, its port matches
`POSTGRES_PORT`, and its database and user match the reused `POSTGRES_DB` and `POSTGRES_USER`.
Verify that its password is the reused `POSTGRES_PASSWORD` without printing either value. Stop on
any mismatch.

Run these commands from the repository root:

```text
corepack pnpm install --frozen-lockfile
docker compose stop app
docker compose up --detach --wait --wait-timeout 120 postgres
corepack pnpm build
corepack pnpm start
```

The stop command prevents the Compose API and the host API from writing at the same time. Do not
start or restart the Compose app while the host API runs.

Compose waits for at most 120 seconds for the PostgreSQL health check. A timeout or unhealthy
service makes the command fail; do not continue to the host build or startup. The template
disables sample data, so the host-started API runs migrations without seeding the synthetic
property.

The host-started API reads `HOST` and `PORT`. The template uses `PORT=13000` with the matching
`ADMIN_ORIGIN=http://127.0.0.1:13000`; change both values together. `POSTGRES_PORT` controls the
PostgreSQL port published to the host and defaults to `15432`. Reserve `API_PORT` for the Compose
app's published port; it does not configure an API process started on the host.

For clean-room verification:

```sh
corepack pnpm docker:clean-room
```

The script builds with `--no-cache --pull`, starts a fresh PostgreSQL 16 project, waits for
`/healthz`, runs the explicit sample seed and public/admin smoke, verifies backup/restore, and
removes only its generated project and volume. It never stops a pre-existing project.

## Runtime configuration

The root `start` and `db:migrate` package scripts, the database check, and the backup/restore
command use Node 22's optional environment-file support. They load the ignored `.env` only when no
deployment identity key is exported. The deployment identity keys are `BOOKING_ENGINE_ENV`,
`DATABASE_URL`, `DATABASE_SCHEMA`, `HOST`, `PORT`, `BOOKING_ENGINE_ORGANIZATION_ID`,
`BOOKING_ENGINE_PROPERTY_ID`, `ADMIN_ORIGIN`, `SECURE_COOKIES`, `BOOKING_ENGINE_SAMPLE_DATA`, and
`BOOKING_ENGINE_SAMPLE_PASSWORD`. If any one of these keys is exported, even with an empty value,
the commands ignore the entire `.env` file. The process environment must then contain a complete
valid configuration for the command. If no identity key is exported, `.env` must contain the
complete valid configuration. These commands fail validation when neither source supplies it.
Only the integration test runner keeps an explicit no-source fallback for no-file local
development. The explicit migration command rejects sample data in every environment.

Required runtime values include `BOOKING_ENGINE_ENV`, `DATABASE_URL`, `HOST`, `PORT`,
`BOOKING_ENGINE_ORGANIZATION_ID`, `BOOKING_ENGINE_PROPERTY_ID`, `ADMIN_ORIGIN`, and
`SECURE_COOKIES`. `DATABASE_SCHEMA` is optional; its effective default is `public` when the value
is unset or empty. `BOOKING_ENGINE_SAMPLE_DATA=true` additionally requires
`BOOKING_ENGINE_SAMPLE_PASSWORD` and is rejected in staging and production. Validation summaries
never print URLs or passwords.

For staging and production, treat the effective schema as part of the approved database identity.
Before migration, decode `DATABASE_URL` without logging it and verify its host, port, database, and
user together with the effective `DATABASE_SCHEMA` value against the approved inventory. Stop on
a missing or mismatched approval. Retain that redacted identity and schema value with the ordered
migration IDs and SHA-256 checksums.

Inject the staging and production environment through the deployment platform, use a protected
PostgreSQL host, set an exact HTTPS `ADMIN_ORIGIN`, set `SECURE_COOKIES=true`, terminate TLS at the
reverse proxy, provision owners outside the sample seed, and apply deployment rate and abuse
controls. Do not expose the Node listener directly to the Internet or use Compose placeholders for
real traffic.

For staging and production, `DATABASE_URL` must contain a real non-empty password and a
non-loopback PostgreSQL host. Its query string must contain exactly
`sslmode=verify-full`; reject missing, repeated, unknown, or weaker parameters.
This is the single approved deployment URL form. Runtime startup and backup validation use the
same query allowlist; local and test URLs may omit TLS for Compose and isolated tests. The local
Compose database intentionally does not use TLS.

## Non-destructive deployment-smoke contract

This gate is deployment-owned. Run it with a deployment-owned authorized client. In staging, use
only the configured HTTPS staging base URL and a designated non-production fixture property. In
production, use only the configured HTTPS production base URL and an approved production smoke
property while application write traffic remains drained. Load dedicated owner credentials at run
time from the deployment secret store. Do not put credentials, cookies, tokens, or database URLs
in command arguments, logs, or evidence.

For each run:

1. Record the environment, start time, release or image identifier, HTTPS base URL, smoke property
   identifier, and a fixed valid arrival and departure date. With a separately provisioned
   read-only database credential, capture the property-scoped row identifiers for
   `booking_requests`, `availability_blocks` rows with `block_kind = 'hold'`, and linked
   `booking_outbox` rows.
2. Exercise only the read-only public contract: `GET /v1/properties/{propertyId}`,
   `GET /v1/properties/{propertyId}/availability` for the fixed dates, and the calculation-only
   `POST /v1/properties/{propertyId}/quote`. Check the expected property, date, availability, and
   quote fields. Do not call `request-to-book`, checkout, or another public mutation.
3. Follow the current
   [admin authentication client guide](../operations/admin-auth.md). Complete login, session
   rotation, and the authenticated session check before the diagnostics. Keep all authentication
   material in private client stores.
4. With that session, exercise only read-only admin diagnostics: `GET /admin`,
   `GET /admin/session`, and the bounded
   `GET /admin/properties/{propertyId}/booking-requests` view for the smoke property. The list is
   newest first and contains at most 100 requests across all statuses. It has no pagination and no
   truncation marker. Never treat it as a complete pending queue. Do not call recheck, approve,
   reject, content, rate, block, or another admin mutation.
5. Complete the guide's full logout procedure. Require HTTP 204, use the isolated old-cookie store
   exactly once for `GET /admin/session`, require HTTP 401 with `invalid_session`, and destroy both
   stores only after revocation is confirmed. Retain redacted confirmation of logout, the isolated
   old-cookie HTTP 401 result, and store destruction. On logout or revocation-check failure, retain
   the primary and isolated stores under access controls for the guide's bounded retry and
   controlled administrative revocation. The smoke and release acceptance fail; store destruction
   after controlled revocation does not convert the failed run into successful evidence.
   Admin-session creation and revocation, plus the bounded `admin_sessions.last_seen_at` touch made
   by each authenticated session lookup required in steps 3–5, are the only permitted application
   mutations during the smoke. They do not restore external business write traffic.
6. Repeat the read-only database snapshot. The property-scoped request, hold, and linked outbox row
   identifier sets must be unchanged. The gate fails if the run creates a booking request, an
   `availability_blocks` hold, or a `booking_outbox` row. Retain the environment, run time, release
   identifier, redacted response checks, full admin-auth result, and redacted before/after database
   evidence. Do not retain guest data, credentials, cookies, tokens, database URLs, or raw database
   rows.

A production cutover requires a successful production run of this complete contract before
acceptance. The local `scripts/smoke-request-to-book.mjs` exercise creates a booking request and
related persistence. Never run it, `docker:clean-room`, or an adapted destructive request-to-book
smoke against staging or production.

## Upgrade and rollback

1. Build the intended commit and run the authoritative
   [development and release gates](../../README.md#development-and-release-gates).
2. Create a staging-only deployment context for the candidate. Require exactly
   `BOOKING_ENGINE_ENV=staging`. Decode `DATABASE_URL` without printing it. Verify its host or
   cluster, port, database, and user, plus the effective `DATABASE_SCHEMA`, against the approved
   staging inventory. The effective schema is `public` when `DATABASE_SCHEMA` is unset or empty.
   Retain the redacted identity and schema value. Stop before `db:migrate` if any value is missing
   or does not match. Never use a production context or database for this rehearsal.
3. Take a verified staging PostgreSQL backup. In the same verified context, run
   `check:env:runtime` and then `db:migrate`. Retain the complete `db:migrate` standard output,
   which contains the ordered migration IDs and SHA-256 checksums. Store it with the approved
   staging database identity and effective schema. The migration report does not contain the
   database URL or schema, so the separate identity record is required.
4. Start the candidate in staging. Confirm `/healthz`, then complete the
   [non-destructive deployment-smoke contract](#non-destructive-deployment-smoke-contract).
   Retain the backup, candidate, health, migration, full admin-auth, persistence no-change, and
   redacted smoke evidence.
5. Approve or reject the staging evidence. Do not start a production migration or cutover until
   the staging evidence has explicit approval.
6. Treat production migration and cutover as a separate, later change. Open a fresh production
   context; do not reuse or modify the staging process. Require exactly
   `BOOKING_ENGINE_ENV=production`. Decode `DATABASE_URL` without printing it. Verify its host or
   cluster, port, database, and user, plus the effective `DATABASE_SCHEMA`, against the approved
   production inventory. Retain the redacted identity and schema value. Stop if any value is
   missing or does not match.
7. Drain all application business writes before the final production backup. Remove public and
   admin mutation traffic and provider ingress from rotation, stop deployment-owned write workers,
   and stop every old-image instance that can write. Use the deployment's configured maximum
   request duration as the finite drain deadline; if no finite duration is configured, the cutover
   is blocked. At the deadline, require zero admitted writes. Reconcile every write that was
   in-flight when the drain began and confirm from deployment and database evidence that it either
   committed completely or rolled back. Stop on an unknown or still-running write.
8. With writes still drained, take and verify the final production PostgreSQL backup. Then run
   `check:env:runtime` and `db:migrate` in the verified production context. Retain the complete
   migration output with its ordered IDs and SHA-256 checksums, the final backup evidence, and the
   approved production database identity and effective schema. Do not start an old image against
   the migrated database.
9. Deploy the approved candidate while external write traffic remains drained. Confirm `/healthz`,
   persistence health, and deployment-owned worker and provider decisions. Give only the cutover
   client access to the candidate, then complete the
   [non-destructive deployment-smoke contract](#non-destructive-deployment-smoke-contract) in
   production. Production evidence must include the full current admin-auth procedure: login and
   session checks, logout, the isolated old-cookie HTTP 401 `invalid_session` proof, confirmed
   store destruction, and only redacted retained evidence. A failed or administratively recovered
   auth run blocks acceptance.
10. Review and record production acceptance while writes remain drained. Require the final backup,
    reconciled-write, database identity, effective schema, migration checksum, candidate, health,
    persistence no-change, full admin-auth, and worker/provider evidence. A missing or failed item
    blocks acceptance and keeps writes drained.
11. Restore traffic only as a separate, recorded action after acceptance. Route it only to the
    accepted candidate and monitor the restored write path. Never restore an old image against the
    migrated database.

This order prevents a committed write after the final backup from being lost and prevents an old
image from writing after migration `010`. Keep the drain in place through migration, candidate
deployment, health checks, non-destructive smoke, and acceptance.

Migrations are forward only. If migration or acceptance fails, keep writes drained and apply the
reviewed database recovery plan. Do not delete migration rows. Do not start the previous image
unless the plan first restores a compatible database from the verified final backup.

## External controls

The deployment owns TLS, reverse-proxy request limits, password rate limiting, secret storage and
rotation, backup encryption/retention, monitoring, image policy, notification transport,
background workers, and live provider activation. This repository does not claim those controls
are implemented.
