> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Bounded iCal slice verification

Date: 2026-07-12

## TDD evidence

The focused suite initially failed 6 tests and passed 26 before the parser, fetcher,
reconciliation, export, health, and store behavior became GREEN.

The persistence slice also recorded 3 failures out of 7 tests before store integration and
property locking: overlap ordering, update-overlap retention, and the 100-writer race.

## Implemented boundaries

- HTTPS-only, pinned-DNS fetches with private-address and metadata blocking, redirect
  revalidation, DNS stability checks, timeout, streaming-body, content-size, and redirect
  limits.
- Defensive UTF-8 iCalendar parsing with BOM tolerance, unfolding, date-only interval
  semantics, event/line/text bounds, duplicate detection, UTC metadata validation, and
  hostile status/timezone/control handling.
- Tenant/property/source/UID reconciliation with idempotent upserts, provenance-aware
  versioned changes and cancellations, conservative missing-event retention, and ambiguity
  decisions.
- Direct-reservation export with CRLF output, UTF-8 line folding, escaping, bounds, and
  independent-parser-style verification.
- PostgreSQL iCalendar storage and availability participation, full source/property
  reconciliation locking, compare-and-set stale-write protection with needs-review outcomes,
  sync health, and immediate tenant-scoped availability recheck APIs.
- Admin sync-health rendering with visible stale/failure state, safe error vocabulary, and
  no source URL or supplied error text rendering.

## Verification gates

- `corepack pnpm format:check` - passed
- `corepack pnpm lint` - passed with zero warnings
- `corepack pnpm typecheck` - passed
- Focused iCalendar suite - 1 file, 41 tests passed
- `corepack pnpm test` - 6 files, 94 tests passed
- `corepack pnpm test:integration` - 4 files, 22 tests passed
- `corepack pnpm check:public-boundary` - passed (5 SDK source files)
- `corepack pnpm build` - passed
- Browser verification was not a repository command; no E2E script exists in the current gate.
- `docker compose config` - passed
- `git diff --check` - passed; only Git line-ending warnings were reported

No production calendar source, credential, private feed URL, or secret is recorded here.
