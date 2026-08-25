> **Archived verification record:** Historical evidence only. Current gates are the root scripts and CI workflow; this dated record is not a release checklist.

# Bounded iCal slice verification

Date: 2026-07-12

Requested model: `gpt-5.6-luna`.

Requested effort: max effort.

Actual initialized model and effort: not exposed by the runtime.

## TDD evidence

The handoff recorded a focused RED because `fetch.ts` was missing. That exact state was not
rerun because the prior artifact was present on arrival. The worker then added edge tests
before their corresponding behavior; the focused suite failed 6 tests and passed 26 before
the parser, fetcher, reconciliation, export, health, and store behavior became GREEN.

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
