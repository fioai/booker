# Self-host deployment

> **Current guide:** This document describes the present pre-release modular-monolith runtime.
> The CI workflow and root scripts are authoritative; dated verification notes are supporting
> evidence only.

The container builds the workspace from the frozen lockfile, compiles `apps/api` and private
workspace packages, runs idempotent migrations on startup, and serves public booking plus
same-origin server-rendered owner admin on one listener. `scripts/migrate.mjs` remains the safe
explicit migration command for release rehearsals. There is no separate migration job in this
slice.

Live Stripe activation, notification delivery, background scheduling, expiry workers, outbox
delivery, and background iCalendar synchronization are not active runtime features. Configure
those as deployment-owned future boundaries rather than assuming they run in this image.

## Local Compose flow

```sh
corepack pnpm install --frozen-lockfile
docker compose up -d postgres
corepack pnpm build
corepack pnpm db:migrate
corepack pnpm start
```

The default host ports are PostgreSQL `15432`, API `13000`, Mailpit SMTP `11025`, and Mailpit
UI `18025`. Override `POSTGRES_PORT`, `API_PORT`, `MAILPIT_SMTP_PORT`, and `MAILPIT_UI_PORT`, or
use a unique Compose project name. CI supplies PostgreSQL service port `5432` explicitly.

For clean-room verification:

```sh
corepack pnpm docker:clean-room
```

The script builds with `--no-cache --pull`, starts a fresh PostgreSQL 16 project, waits for
`/healthz`, runs the explicit sample seed and public/admin smoke, verifies backup/restore, and
removes only its generated project and volume. It never stops a pre-existing project.

## Runtime configuration

Copy `.env.example` to an ignored `.env` only for host-command overrides. The Node scripts do
not load `.env` automatically; export values in the shell before validating or migrating:

```sh
corepack pnpm check:env:runtime
corepack pnpm db:migrate
```

Required runtime values include `BOOKING_ENGINE_ENV`, `DATABASE_URL`, `DATABASE_SCHEMA`, `HOST`,
`PORT`, `BOOKING_ENGINE_ORGANIZATION_ID`, `BOOKING_ENGINE_PROPERTY_ID`, `ADMIN_ORIGIN`, and
`SECURE_COOKIES`. `BOOKING_ENGINE_SAMPLE_DATA=true` additionally requires
`BOOKING_ENGINE_SAMPLE_PASSWORD` and is rejected in staging/production. Validation summaries
never print URLs or passwords.

For staging/production, use a protected PostgreSQL host, an exact HTTPS `ADMIN_ORIGIN`,
`SECURE_COOKIES=true`, TLS at the reverse proxy, external owner provisioning, and deployment
rate/abuse controls. Do not expose the Node listener directly to the Internet or use Compose
placeholders for real traffic.

## Upgrade and rollback

1. Build and run the complete CI-equivalent gate from the intended commit.
2. Take a verified PostgreSQL backup.
3. Run `check:env:runtime`, `db:migrate`, and the public/admin smoke against staging.
4. Roll forward only after migration checksum and backup checks pass. Migrations are forward
   only; rollback means restoring the previous image and applying a reviewed database recovery
   plan, not deleting migration rows.
5. Confirm `/healthz`, admin login/CSRF behavior, persistence health, and deployment-owned
   worker/provider decisions before accepting traffic.

## External controls

The deployment owns TLS, reverse-proxy request limits, password rate limiting, secret storage and
rotation, backup encryption/retention, monitoring, image policy, notification transport,
background workers, and live provider activation. This repository does not claim those controls
are implemented.
