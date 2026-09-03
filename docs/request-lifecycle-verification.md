> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Request lifecycle verification

Date: 2026-07-12

## Scope

This record covers request-to-book lifecycle behavior: bounded state transitions, immutable quote
snapshots, tenant-scoped idempotent submission, transactional internal holds, pending-only public
submission, owner approval/rejection/recheck operations, a PostgreSQL transactional outbox, and
the privacy-minimized public V1 boundary.

Outbox tests use only an in-process deterministic delivery port.

## Invariants exercised

- A request is `pending` until exactly one explicit terminal transition: `approved`,
  `rejected`, or `expired`. Terminal transitions are rejected without lifecycle side effects.
  Internal submission creates an expiring hold; public submission creates no active inventory.
  Approval promotes an internal hold or inserts an occupancy for a public pending request;
  it does not imply a later payment/confirmation workflow.
- Submission validates bounded guest/request fields and canonicalizes a server quote into a
  frozen snapshot. The quote snapshot is included in the idempotency fingerprint.
- Submission takes the tenant/property advisory lock, expires stale requests/holds, and writes
  the request plus `booking_request.submitted` in one PostgreSQL transaction. Internal
  submissions also create an expiring hold. Public submissions explicitly defer inventory;
  they create no active hold, so repeated unauthenticated submissions cannot block dates.
  PostgreSQL's active-range exclusion constraint remains the authoritative overlap boundary;
  failed inserts roll back the request, inventory (when applicable), and outbox together.
- Idempotency keys are unique within an organization. Same-key retries return the original
  request; a changed request or quote is an explicit `idempotency_key_reuse` error, including
  the concurrent unique-index race across properties.
- Owner actions require the organization/property scope, lock the property and request, and
  recheck native availability plus iCalendar conflict atomically before approval. A stale
  internal hold or public pending request expires conservatively; approval conflicts leave the
  pending request, any hold, and outbox unchanged.
- Outbox event types, statuses, attempts, error codes, and error messages are bounded by the
  database and delivery abstraction. Lifecycle changes and their outbox events commit or roll
  back together.
- Public serializers and SDK guards omit guest contact, organization scope, private notes,
  hold/fingerprint/idempotency fields, and outbox payload internals. `Idempotency-Key` is a
  transport header and is not part of the public request body or response.

## Initial focused check

The initial focused check covered the request-to-book lifecycle and public boundary before the
repair:

```text
corepack.cmd pnpm exec vitest run packages/booking-core/test/request-lifecycle.test.ts tests/integration/request-lifecycle.test.ts apps/api/test/public/booking/api.test.ts apps/api/test/public/booking/http-server.test.ts packages/sdk-typescript/test/public-contract.test.ts
```

Result: exit `0`; 5 files and 34 tests passed.

## Repair RED → GREEN checkpoints

1. Quote changes under a reused key.

```text
RED: corepack.cmd pnpm exec vitest run tests/integration/request-lifecycle.test.ts -t "immutable quote snapshot changes" --reporter=verbose
RED result: exit 1; the promise resolved the original pending request instead of returning idempotency_key_reuse.
GREEN result: exit 0; the focused test passed after the canonical quote was included in the fingerprint.
```

2. Atomic public submission boundary.

```text
RED: corepack.cmd pnpm exec vitest run apps/api/test/public/booking/api.test.ts -t "legacy non-atomic" --reporter=verbose
RED result: exit 1; a create-only dependency resolved a public request through the legacy check-then-create fallback.
GREEN result: exit 0; the focused API selection passed after the public composition boundary required submit and failed closed.
```

3. Malformed direct persistence inputs.

```text
RED: corepack.cmd pnpm exec vitest run tests/integration/request-lifecycle.test.ts -t "malformed direct submissions" --reporter=verbose
RED result: exit 1; null input produced invalid_booking_request_id, then null options produced a raw TypeError.
GREEN result: exit 0; malformed input/options now return booking_request_validation.
```

4. Public OpenAPI idempotency header.

```text
RED: corepack.cmd pnpm exec vitest run packages/sdk-typescript/test/public-contract.test.ts -t "publishes the four" --reporter=verbose
RED result: exit 1; request-to-book parameters contained only the property reference.
GREEN result: exit 0; the required bounded Idempotency-Key component/reference is documented.
```

5. Concurrent tenant-wide idempotency classification.

```text
RED: corepack.cmd pnpm exec vitest run tests/integration/request-lifecycle.test.ts --reporter=dot
RED result: exit 1 during the repeated focused run; 13 tests passed and the concurrent key race returned duplicate_booking_request instead of idempotency_key_reuse.
GREEN: corepack.cmd pnpm exec vitest run tests/integration/request-lifecycle.test.ts -t "concurrent tenant-wide" --reporter=verbose
GREEN result: exit 0; the PostgreSQL idempotency unique-index constraint is classified explicitly.
```

Additional deterministic outbox privacy coverage passed after the existing implementation was
audited:

```text
corepack.cmd pnpm exec vitest run tests/integration/request-lifecycle.test.ts -t "bounded outbox payload" --reporter=verbose
Result: exit 0; the delivery event was frozen and contained no guest contact/private request data.
```

## Final verification

The final rows below are populated from the last commands run after the repair and formatting
pass.

| Command                                       | Result                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `corepack.cmd pnpm install --frozen-lockfile` | exit `0`; pnpm `10.12.1`, lockfile unchanged                          |
| `corepack.cmd pnpm format:check`              | exit `0`; all files matched Prettier                                  |
| `corepack.cmd pnpm lint`                      | exit `0`; ESLint passed with `--max-warnings=0` and no warnings       |
| `corepack.cmd pnpm typecheck`                 | exit `0`; project references and strict test typecheck passed         |
| `corepack.cmd pnpm test`                      | exit `0`; 7 package test files, 102 tests passed                      |
| `corepack.cmd pnpm test:integration`          | exit `0`; 5 PostgreSQL integration files, 37 tests passed             |
| `corepack.cmd pnpm check:public-boundary`     | exit `0`; 5 SDK source files audited, no workspace imports            |
| `corepack.cmd pnpm build`                     | exit `0`; strict composite build passed                               |
| `docker compose config`                       | exit `0`; local PostgreSQL/Mailpit config rendered                    |
| `git diff --check`                            | exit `0`; Git emitted only the expected LF-to-CRLF conversion warning |

No E2E gate was faked or run as part of this slice.
