# Contributing

## Supported development toolchain

Use Node.js 22.23.1 and pnpm 10.12.1. Install dependencies with the frozen lockfile:

```sh
corepack pnpm install --frozen-lockfile
```

The repository currently enforces the Node 22 engine range. Do not update the lockfile as
part of an unrelated change.

## Package boundaries

This repository is one modular monolith. `apps/api` is the composition and same-origin,
server-rendered owner-admin surface. `@booking-engine/sdk-typescript` is the only public
package in the first release. `booking-core`, `database-postgres`, `payments`,
`payments-stripe`, `channel-calendar`, `channel-ical`, `notifications`, and `test-support`
are private implementation or test packages.

External consumers use the SDK and public HTTP contract. Application code must not import
private admin, database, or domain internals on behalf of an external storefront. PostgreSQL
owns persistence and canonical projections; the API owns SDK V1 serialization.

## Local PostgreSQL integration

The documented local service uses PostgreSQL through the Compose host port `15432`:

```sh
cp .env.example .env
corepack pnpm install --frozen-lockfile
docker compose up -d postgres
corepack pnpm build
corepack pnpm db:migrate
corepack pnpm start
```

Set `DATABASE_URL` to the Compose host port. Integration suites create isolated schemas and
clean them up. CI overrides the URL to its PostgreSQL service on port `5432`.

## Required checks

Run the focused checks while changing a module, then the complete release gate before opening
a pull request:

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

Docker-backed checks require a running Docker engine. Do not replace them with mocked claims.

## Migrations

Migration files are append-only and run in lexical order from the explicit list in the
PostgreSQL migration runner. Never edit an applied SQL file. Add a new migration for schema
changes. The runner records SHA-256 checksums and fails closed when an already-checksummed file
changes; legacy rows without checksums are baselined once.

## Changes and review

Keep public V1 routes, statuses, error codes/messages, date semantics, money units,
idempotency behavior, tenant scoping, and privacy omissions stable unless a new ADR explicitly
changes the contract. Add contract-level tests for new observable behavior. Keep generated
`dist` output and local environment files out of commits.
