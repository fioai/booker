> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. The former `apps/admin`
> package and standalone admin listener are removed; use `apps/api` admin views and
> `createApiHttpServer`.

# Owner authentication and same-domain admin verification

This record covers owner authentication and private admin responses in the existing modular-monolith
HTTP boundary. `apps/api` owns authentication and private admin responses,
`packages/database-postgres` owns tenant-scoped persistence, and the server-rendered admin views
live under `apps/api`.

## TDD evidence

Production behavior was added in focused RED → minimal GREEN slices. The commands below use
the checked-in workspace toolchain through `corepack.cmd pnpm`.

| Slice                       | RED observed                                                                                                                                                                                                        | GREEN observed                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin route/list boundary   | `corepack.cmd pnpm exec vitest run apps/api/test/admin-http-api.test.ts -t "lists private booking requests" --reporter=verbose` exited 1 with `route_not_found`/404, then exposed a 500 from the incomplete branch. | The same focused test exited 0 after the tenant property load and bound repository list call were completed.                                                               |
| Owner credential repository | `corepack.cmd pnpm exec vitest run packages/database-postgres/test/owner/auth-repository.test.ts --reporter=verbose` exited 1 because `createOwnerCredentialRepository` was not implemented.                        | The focused repository suite exited 0 with identity/membership transaction coverage.                                                                                       |
| PostgreSQL session adapter  | `corepack.cmd pnpm exec vitest run apps/api/test/admin/postgres-auth.test.ts --reporter=verbose` exited 1 because the persistent credential/session factories were not implemented.                                 | The focused suite exited 0; opaque token digest, reload, CSRF verification, and revocation tests passed.                                                                   |
| Response privacy            | The added assertion that login responses omit the organization scope exited 1 and showed `organizationId` in the response body.                                                                                     | The focused authentication test exited 0 after the explicit admin user allowlist was applied.                                                                              |
| Password storage            | The added repository test exited 1 because a plaintext verifier was accepted by the repository seam.                                                                                                                | The focused test exited 0 after the scrypt verifier shape was enforced before the transaction.                                                                             |
| Password profile            | The added repository test exited 1 because a different scrypt cost profile was accepted.                                                                                                                            | The focused test exited 0 after the documented `16384/8/1` profile was enforced.                                                                                           |
| PostgreSQL request listing  | The real integration request-list call initially returned 500 because the class method was detached from its repository instance.                                                                                   | `corepack.cmd pnpm exec vitest run tests/integration/admin-http-postgres.test.ts --reporter=verbose` exited 0 after invoking the list method with its repository receiver. |

An initial typecheck failed on admin exports and defensive payload typing; the strict composite/test
typecheck is green in the final gates below.

## Verification commands

Final command output is recorded here after the implementation gates are run:

```text
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm format:check
corepack.cmd pnpm lint
corepack.cmd pnpm typecheck
corepack.cmd pnpm test
corepack.cmd pnpm test:integration
corepack.cmd pnpm check:public-boundary
corepack.cmd pnpm build
docker compose config
git diff --check
```

Observed final results:

- install exited 0 (`pnpm 10.12.1`, lockfile already up to date).
- format check, lint (`--max-warnings=0`), typecheck, build, and diff check exited 0.
- package test exited 0: 8 files, 106 tests passed.
- integration test exited 0: 6 files, 40 PostgreSQL-backed tests passed.
- the app/API suite exited 0: 5 files, 32 tests passed.
- public-boundary check exited 0: 5 SDK source files audited.
- `docker compose config` exited 0 and rendered the local Postgres/Mailpit configuration.

## Security review and threat notes

### Passwords and credential failures

- Only a bounded scrypt verifier is accepted at the application and PostgreSQL credential seams;
  plaintext is rejected before persistence. Parameters are `N=16384`, `r=8`, `p=1`, a 16-byte
  random salt, and a 32-byte derived key, using Node's maintained built-in `crypto.scrypt`.
- Passwords are never logged or returned. Credential lookup normalizes bounded email input and
  uses a precomputed scrypt verifier on missing/invalid account paths where practical, keeping
  the expensive primitive in the normal failure path.
- The current slice deliberately has no process-local account lockout. A production deployment
  gate is an account/IP-aware rate limiter at the trusted reverse proxy or an equivalent shared
  limiter, with monitoring and an MFA decision before internet exposure; lockout must not become
  a tenant-wide denial-of-service primitive.

### Sessions, fixation, and CSRF

- Session and CSRF values are independently generated from 32 random bytes. PostgreSQL stores
  only SHA-256 base64url digests of those values; raw values exist only in the client cookie and
  the active request/session ticket.
- Sessions have bounded expiry (8 hours by default, at most 24 hours), are pruned/capacity-bound,
  and have explicit `revoked_at` logout state. A successful login destroys a pre-existing session
  before issuing a new one, preventing session fixation. Reload also requires a live identity and
  active organization membership, so membership revocation and role changes fail closed.
- The session cookie is host-only (no `Domain`), `Path=/`, `HttpOnly`, `SameSite=Strict`, and
  `Secure` by default. The local HTTP tests set `secureCookies: false` only for loopback HTTP.
  The CSRF cookie is non-HttpOnly so a browser form/script can submit its value, but is still
  host-only/SameSite and is checked against the request token in constant behavior.
- Every mutation requires the double-submit token and, when supplied/configured, an exact
  same-origin `Origin`/`Referer` check. The production composition gate is an explicit trusted
  HTTPS origin behind a correctly configured proxy; no wildcard origin is accepted.

### Tenant confusion and authorization

- The authenticated membership supplies the sole organization scope. Every property, rate,
  availability, iCal-health, and booking-request repository call receives that scope; PostgreSQL
  keys and queries include organization identity. Missing/wrong-tenant resources are generic 404s.
- Viewer sessions fail closed for private reads/mutations. Booking approve/reject/recheck is
  restricted to owner/admin roles; existing domain repository transitions remain the source of
  booking semantics and transactions.
- Persistent session reload does not trust the stored role snapshot: it joins the active identity
  and membership and uses the current role. Revoked memberships, disabled identities, expired
  sessions, and revoked sessions all become invalid sessions.

### Public/private boundary and deployment gates

- Public property/request serializers are explicit allowlists. They omit operational notes,
  guest contact/message fields, organization scope, auth material, session data, and outbox
  internals. Private guest fields exist only in authorized admin responses.
- iCal health responses map provider/network details to bounded stable status messages. No admin
  or public handler logs secrets, passwords, cookies, database errors, or upstream URLs.
- Before production exposure, require TLS/HSTS at the edge, a trusted exact origin, secure cookie
  mode, shared rate limiting, secret injection outside the repository, database backup/restore
  rehearsal, migration review, session revocation/audit monitoring, and a browser-integrated
  CSP/CSRF review. No production email/network delivery or production secret was used here.

Browser E2E is intentionally not claimed; it belongs to the later integrated storefront/admin
slice.
