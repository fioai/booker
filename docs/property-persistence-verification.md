> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# PostgreSQL property persistence verification

Date: 2026-07-12

## RED evidence

The inherited strict domain RED record remains in `docs/property-configuration-verification.md`.
This repair added failing tests before the corresponding production fixes:

- Initial `corepack.cmd pnpm format:check`: exit `1`; Prettier reported `66` files,
  caused by checkout end-of-line handling.
- After the unit-gate follow-up reverted the formatter setting for its deterministic
  check, the same command reported `62` files; retaining the narrowly necessary
  end-of-line setting made the final gate pass without baseline rewrite churn.
- `corepack.cmd pnpm test:integration -- --reporter=verbose`: exit `1`; `8` tests ran,
  `3` failed and `5` passed. The failures exposed unbounded organization names, missing
  database identifier constraints, and the concurrent migration race.
- `corepack.cmd pnpm exec vitest run packages/database-postgres/test/property-repository.test.ts --reporter=verbose`:
  exit `1`; `5` corruption tests failed because invalid public counts/bed quantities escaped.

## Implemented GREEN behavior

- Organization names are domain-limited to `120` Unicode code points and database-limited
  with matching checks. Organization/property identifiers use the same 64-character
  ASCII identifier shape in application validation and PostgreSQL constraints.
- Migrations run inside a transaction-scoped advisory lock. The integration suite runs two
  real concurrent migration processes and a repeat idempotency pass.
- Public properties are read through an explicit view and revalidated through the canonical
  domain factory before SDK projection; operational notes never enter the public shape.
- Every property read, list, update, delete, and public query includes the organization scope.
  Integration fixtures use a unique schema and arrange/clean organizations per test.
- Reverting the inherited `endOfLine: 'auto'` setting made `format:check` fail on 62
  existing CRLF/mixed-line-ending files in this Windows checkout. The setting was retained
  as the narrowly scoped exception required for the deterministic repository-wide format
  gate; no unrelated source formatting was rewritten.

## Deterministic test-separation checkpoint

The PostgreSQL service was stopped with `docker compose stop postgres`. With PostgreSQL
unavailable, the repaired unit command was rerun:

```text
corepack.cmd pnpm test
```

Result: exit `0`; 3 package test files and 40 tests passed, with no integration file
collected. The existing compose database setup and volume remained intact.

PostgreSQL was then started with `docker compose up -d postgres` and reached `healthy`.
The real integration command was rerun against that service:

```text
corepack.cmd pnpm test:integration
```

Result: exit `0`; 1 Docker-backed integration file and 8 tests passed.

## Verification

Verification used the pinned Corepack package manager; Corepack reported pnpm `10.12.1`.

| Command                                                     | Exact result                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `corepack.cmd pnpm install --frozen-lockfile`               | exit `0`; lockfile up to date; pnpm `10.12.1`                            |
| `corepack.cmd pnpm format:check`                            | exit `0`; all files matched Prettier                                     |
| `corepack.cmd pnpm lint`                                    | exit `0`; zero warnings with `--max-warnings=0`                          |
| `corepack.cmd pnpm typecheck`                               | exit `0`; project and package/integration tests typechecked              |
| `corepack.cmd pnpm exec vitest run packages --reporter=dot` | exit `0`; `3` package files, `40` tests                                  |
| `corepack.cmd pnpm test`                                    | exit `0`; `3` package files, `40` tests with PostgreSQL stopped          |
| `corepack.cmd pnpm test:integration`                        | exit `0`; `1` Docker-backed file, `8` tests against healthy PostgreSQL   |
| `corepack.cmd pnpm build`                                   | exit `0`                                                                 |
| `docker compose config`                                     | exit `0`; PostgreSQL 16 and Mailpit rendered                             |
| `git diff --check`                                          | exit `0`; no whitespace errors; Git emitted expected LF-to-CRLF warnings |

Docker PostgreSQL was healthy during the real integration runs (`postgres:16-alpine`,
published on local port `5432`).

## Limitations

Tenant isolation is enforced at this repository boundary; PostgreSQL row-level security,
authentication, availability, occupancy, API handlers, and deployment behavior remain out
