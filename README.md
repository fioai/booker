# Booking Engine

Booking Engine is a pre-release, self-hostable modular monolith for property booking. The
runtime is composed in `apps/api`; it is not a service mesh and does not require a speculative
`common`, `kernel`, or application package. The first public package is
`@booking-engine/sdk-typescript` at `0.1.0`.

The current runtime intentionally does **not** activate live Stripe payments, notification
transport, background scheduling, expiry workers, outbox delivery, or iCalendar sync workers.
Those are explicit deferred boundaries, not implied features.

## Ownership and dependency direction

| Area                         | Responsibility                                                                      | Release boundary   |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `apps/api`                   | HTTP composition, public booking transport, same-origin server-rendered owner admin | private            |
| `packages/booking-core`      | domain invariants, local dates, money, quotes, lifecycle rules                      | private            |
| `packages/database-postgres` | scoped PostgreSQL persistence, migrations, canonical projections                    | private            |
| `packages/payments`          | payment ports and test-mode lifecycle contracts                                     | private            |
| `packages/payments-stripe`   | Stripe adapter seam; not activated by the runtime                                   | private            |
| `packages/channel-calendar`  | calendar channel contract                                                           | private            |
| `packages/channel-ical`      | iCalendar adapter and port                                                          | private            |
| `packages/notifications`     | notification contract boundary; no transport                                        | private            |
| `packages/test-support`      | deterministic test helpers                                                          | private            |
| `packages/sdk-typescript`    | dependency-free V1 consumer contract and client                                     | **public `0.1.x`** |

The intended workspace edges are:

```text
channel-ical -> channel-calendar
payments-stripe -> payments
database-postgres -> booking-core, payments, channel-ical
apps/api -> booking-core, database-postgres, channel-ical, payments, sdk-typescript
```

Persistence returns canonical domain properties. Only the API mapper serializes SDK V1 property
responses. External storefronts use the SDK and public HTTP contract; they do not import admin,
database, or domain internals.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/adr/0001-modular-monolith.md`](docs/adr/0001-modular-monolith.md), and
[`docs/adr/0006-open-source-release-boundary.md`](docs/adr/0006-open-source-release-boundary.md).

## Prerequisites

- Node.js `22.23.1`;
- pnpm `10.12.1` through Corepack;
- Docker Engine and Compose for PostgreSQL-backed checks.

Linux, macOS, and Windows users can run the same commands from a shell with Docker Compose
available.

## Quickstart

```sh
cp .env.example .env
corepack pnpm install --frozen-lockfile
docker compose up -d postgres
corepack pnpm build
corepack pnpm db:migrate
corepack pnpm start
```

The local Compose PostgreSQL host port is `15432`; the app listens on `HOST`/`PORT` from the
environment template. `scripts/run-api.mjs` keeps its current idempotent migration-on-start
behavior. `scripts/migrate.mjs` remains the explicit migration command for release rehearsals.

Public and admin smoke examples:

```sh
curl http://127.0.0.1:13000/healthz
curl http://127.0.0.1:13000/v1/properties/sample-bungalow
curl http://127.0.0.1:13000/admin/login
```

The owner admin is same-origin and server-rendered by `apps/api`. It is a reference surface,
not a browser-admin SDK.

## Development and release gates

The CI workflow and root scripts are authoritative. Dated verification notes under `docs/` are
supporting evidence only.

```sh
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm check:architecture
corepack pnpm check:public-boundary
corepack pnpm check:public-contract
corepack pnpm check:sdk-package
corepack pnpm check:env
corepack pnpm scan:secrets
corepack pnpm audit:dependencies
git diff --check
docker compose config
```

When Docker is available, also run:

```sh
corepack pnpm docker:clean-room
```

Integration tests use isolated schemas. CI supplies a PostgreSQL service URL on port `5432`;
the documented local Compose flow uses host port `15432`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — maintainer map and invariants;
- [`docs/deployment/self-host.md`](docs/deployment/self-host.md) — deployment flow;
- [`docs/operations/owner-runbook.md`](docs/operations/owner-runbook.md) — owner operations;
- [`docs/security/threat-model.md`](docs/security/threat-model.md) — security assumptions and
  deployment-owned controls;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development and migration policy;
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting;
- [`packages/sdk-typescript/README.md`](packages/sdk-typescript/README.md) — public client usage.

## License

MIT. See [`LICENSE`](LICENSE).
