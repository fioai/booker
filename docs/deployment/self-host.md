# Self-host deployment

This repository supports a bounded self-host path for the modular monolith. The
container image builds the workspace from the lockfile, compiles the API and its
workspace packages, runs migrations against PostgreSQL, and starts the public and
same-origin owner-admin HTTP boundaries. It does not contain a production account,
payment activation, iCalendar URL, email credential, or provider secret.

## Local clean-room verification

Use a unique Compose project when another local stack is using the usual ports. The
repository verifier chooses unique ports and a fresh named volume automatically:

    corepack.cmd pnpm install --frozen-lockfile
    corepack.cmd pnpm build
    corepack.cmd pnpm docker:clean-room

docker:clean-room performs a docker compose build --no-cache --pull, starts a
fresh PostgreSQL 16 and Mailpit project, waits for /healthz, runs migrations and
the explicit local sample seed, exercises property/availability/quote/request-to-book
through the public boundary, logs in through the admin boundary, rechecks and
approves the request, and performs backup/restore verification. It removes only the
generated project and volume. It never stops or removes a pre-existing project.

For an interactive local stack:

    docker compose --project-name booking-engine-local up -d

The default host ports are PostgreSQL 15432, API 13000, Mailpit SMTP 11025,
and Mailpit UI 18025. Override them with POSTGRES_PORT, API_PORT,
MAILPIT_SMTP_PORT, and MAILPIT_UI_PORT, or use a different project name. The app
container does not mount the host repository or host node_modules.

The local sample is intentionally opt-in inside Compose. Its only credentials are
known local fixtures: sample-owner@example.test and local-only-owner-password.
They are not acceptable production credentials.

## Runtime configuration

Copy .env.example to an ignored local file only when host commands need overrides.
Compose reads that file automatically when it is named `.env`; the Node scripts do not
load `.env` themselves. Export the values in the shell (the PowerShell and Git Bash
examples in [backup and restore](../operations/backup-restore.md) show the exact form)
before validating or migrating a host-built app:

    corepack.cmd pnpm check:env:runtime
    corepack.cmd pnpm db:migrate

Required runtime values are BOOKING_ENGINE_ENV, DATABASE_URL, DATABASE_SCHEMA (default
public), HOST, PORT, BOOKING_ENGINE_ORGANIZATION_ID, and BOOKING_ENGINE_PROPERTY_ID.
BOOKING_ENGINE_SAMPLE_DATA=true additionally requires BOOKING_ENGINE_SAMPLE_PASSWORD and is rejected
in staging or production. Validation reports names, ports, and modes only; it never
prints DATABASE_URL or a password.

For staging/production, use a managed PostgreSQL instance or a separately protected
PostgreSQL host, an exact HTTPS ADMIN_ORIGIN, SECURE_COOKIES=true, and TLS at the
reverse proxy. Provision owner identities through an external controlled process.
Do not expose the Node listener directly to the Internet, and do not use the Compose
local placeholders for a real deployment.

## Upgrade and rollback

1. Build and test the candidate image from the intended commit.
2. Take a verified PostgreSQL backup.
3. Start the candidate against a staging database and run check:env:runtime,
   db:migrate, public-boundary checks, and the local-equivalent smoke exercise.
4. Roll forward only after the migration and backup checks pass. This repository has
   forward-only migration files; a rollback means restoring the previous application
   image and applying a reviewed database recovery plan, not deleting migration rows.
5. Confirm /healthz, admin login/CSRF behavior, outbox health, iCalendar freshness,
   and payment webhook rejection behavior before accepting traffic.

## Container assumptions and limits

The image pins the Node and pnpm versions used by the workspace and installs only
from pnpm-lock.yaml. Base image tags still require an organization-approved image
digest policy if byte-for-byte rebuild provenance is required. The local Compose
Mailpit service is a development sink, not a production mail relay. Stripe remains
test-mode-only in this slice, and Airbnb/iCalendar integration must be configured
with the SSRF-safe adapter and externally managed secrets.
