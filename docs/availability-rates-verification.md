> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Availability and rates verification

Date: 2026-07-12

## RED checkpoint

Focused tests were created before the new production modules. The first command attempt
was only a missing-dependency prerequisite (`vitest` was not found); the frozen workspace
install completed successfully before the actual RED run.

Core RED command:

```text
corepack.cmd pnpm exec vitest run packages/booking-core/test/availability-rates.test.ts --reporter=verbose
```

Exact result excerpt:

```text
Test Files 1 failed (1)
Tests no tests
FAIL packages/booking-core/test/availability-rates.test.ts
Error: Cannot find module '../src/availability-rates.js'
```

PostgreSQL RED command:

```text
corepack.cmd pnpm exec vitest run tests/integration/availability-rates.test.ts --reporter=verbose
```

Exact result excerpt:

```text
Test Files 1 failed (1)
Tests 4 skipped (4)
TypeError: (0 , createAvailabilityRepository) is not a function
```

These failures were captured before adding the domain, repositories, migration, or
database behavior.

## Implemented behavior

- `booking-core` accepts bounded Gregorian `YYYY-MM-DD` local dates only. Intervals are
  strictly positive, capped at 3,660 nights, and use `[arrival, departure)` overlap
  semantics independent of host timezone or DST.
- Rate plans use active ISO currency codes and bounded non-negative integer minor units
  for base nightly rates, seasonal nightly overrides, cleaning fees, and minimum stay.
  Seasonal intervals cannot overlap. Quotes include every local night, source, subtotal,
  cleaning fee, total, currency, and minimum stay.
- PostgreSQL stores plans in integer `BIGINT` columns and seasonal overrides in bounded
  `DATERANGE` rows with a no-overlap exclusion constraint.
- Manual blocks, holds, and confirmed occupancy share `availability_blocks`. The database
  exclusion constraint is keyed by organization, property, and `stay WITH &&`, and its
  predicate is only static `status = 'active'`. It contains no `CURRENT_TIMESTAMP` or
  `now()` predicate.
- Hold expiry is explicit: `releaseExpiredHolds(scope, at)` changes eligible active hold
  rows to released. Availability does not infer expiry from wall-clock time. Holds can
  also be explicitly released or confirmed; confirmed occupancy and manual blocks release
  explicitly as well.
- Every new repository operation validates the tenant/property scope. A property in a
  different tenant is reported as `property_not_found`; invalid dates, IDs, expiry values,
  rate amounts, minimum stays, and quote lengths are rejected before persistence.
- The public SDK was not given private server dependencies. The public-boundary script
  passes with one audited SDK source file.

## GREEN checkpoint

Focused core GREEN command:

```text
corepack.cmd pnpm exec vitest run packages/booking-core/test/availability-rates.test.ts --reporter=verbose
```

Exact final result:

```text
Test Files 1 passed (1)
Tests 7 passed (7)
```

The final real PostgreSQL GREEN command ran both integration files:

```text
corepack.cmd pnpm test:integration
```

Exact final result:

```text
Test Files 2 passed (2)
Tests 12 passed (12)
```

The availability integration file contains four tests, including 100 sequential races.
Each race starts two real PostgreSQL transactions inserting overlapping holds; exactly
one promise is fulfilled and one is rejected by the database exclusion boundary. The
test passed all 100 iterations.

## Final verification

The final commands below used the pinned Corepack package manager.

| Command                                       | Result                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `corepack.cmd pnpm install --frozen-lockfile` | exit `0`; lockfile up to date; pnpm `10.12.1`                                   |
| `corepack.cmd pnpm format:check`              | exit `0`; all files matched Prettier                                            |
| `corepack.cmd pnpm lint`                      | exit `0`; zero warnings with `--max-warnings=0`                                 |
| `corepack.cmd pnpm typecheck`                 | exit `0`; project and test TypeScript checks passed                             |
| `corepack.cmd pnpm test`                      | exit `0`; 4 package files, 46 tests passed                                      |
| `corepack.cmd pnpm test:integration`          | exit `0`; 2 PostgreSQL files, 12 tests passed                                   |
| Browser verification (historical)             | No repository E2E script exists; verify the actual deployed surface separately. |
| `corepack.cmd pnpm check:public-boundary`     | exit `0`; public boundary passed with 1 SDK source file                         |
| `corepack.cmd pnpm build`                     | exit `0`                                                                        |
| `docker compose config`                       | exit `0`; PostgreSQL 16 and Mailpit rendered                                    |
| `git diff --check`                            | exit `0`; only expected Windows LF-to-CRLF warnings                             |
