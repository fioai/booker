# Contributing

## Supported development toolchain

Use Node.js 22.23.1 and pnpm 10.12.1. Install dependencies with the frozen lockfile:

On Windows Git Bash, PowerShell, or Command Prompt, use `corepack.cmd pnpm` if the
extensionless `corepack` shim fails. Make this substitution for the install command
and every later pnpm command. The canonical POSIX command remains below.

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

Follow the root [Quickstart](README.md#quickstart). It gives the environment-file copy command
for POSIX shells, Windows PowerShell, and Windows Command Prompt, then starts PostgreSQL and the
seeded app in Compose with the same finite 120-second readiness timeout.

The Compose app binds its local database connection, sample flag, and sample password in one
service configuration. The local template disables sample data for host-started processes. The
explicit `db:migrate` release command rejects sample data by design. Integration suites create
isolated schemas and clean them up. CI overrides the database URL with its PostgreSQL service
on port `5432`.

## Required checks

The root [Development and release gates](README.md#development-and-release-gates) checklist is the
single authoritative release command list. Run focused checks while changing a module, then run
every command in that checklist before opening a pull request. This includes the explicitly
confirmed backup/restore rehearsal and the Docker clean-room gate. Do not maintain a second,
partial command list here.

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
