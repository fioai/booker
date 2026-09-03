# Threat model

> **Current status:** This is the current pre-release threat model for the modular monolith.
> CI scripts and the workflow are the release gate. Dated verification records are evidence only.
> Live Stripe, notification transport, background scheduling, and worker delivery are not
> activated runtime features.

## Scope and assumptions

The system exposes public property/availability/quote/request routes, a same-origin
server-rendered owner admin, bounded iCalendar ingestion ports, PostgreSQL persistence, and
provider-neutral/test-mode payment boundaries. A deployment supplies TLS termination, secret
management, PostgreSQL access controls, backups, monitoring, reverse-proxy limits, and owner
provisioning. Compose passwords, sample owners, Mailpit, and sample properties are development
fixtures only.

## Assets and boundaries

Tenant-owned domain queries and keys require organization scope. Property-owned data also
requires property scope. Some trusted operational repositories deliberately use global technical
keys:

- outbox dispatch claims and acknowledges `booking_outbox` rows by `outbox_id`; each event keeps
  its organization and property scope, and only trusted delivery code may use this global queue;
- persistent admin sessions resolve an opaque `session_digest`; session use rechecks active
  organization membership, expiry, revocation, and CSRF, and raw session tokens are not stored; and
- payment webhook deduplication uses `(provider, provider_event_id)`; trusted ingress must verify
  the signature and provider account before repository processing, which then checks the scoped
  checkout, amount, currency, and occupancy.

These global keys are not tenant-facing lookup APIs. They and their private results must not
appear in public responses or logs.

| Asset/boundary      | Main threat                                                                                | Controls and remaining ownership                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant/privacy data | Cross-tenant reads/writes; operational notes or guest PII crossing public responses        | Tenant-owned repositories require organization scope and property scope where applicable; the public SQL view is canonicalized; the API mapper has an explicit SDK allowlist; public and persistence tests assert negative leakage.                                                                                                                                                                                                                                          |
| Admin auth/session  | Credential stuffing, session theft/fixation, stale membership, CSRF                        | Scrypt-backed password verification, bounded sessions, HttpOnly/SameSite cookies, membership checks, logout revocation, exact-origin plus CSRF checks. TLS, edge rate limits, recovery, and provisioning remain deployment controls.                                                                                                                                                                                                                                         |
| Request inventory   | Overlapping holds/occupancy; public request abuse                                          | PostgreSQL half-open daterange exclusion and tenant/property advisory lock are authoritative. Public request-to-book persists pending state without inventory; approval rechecks and inserts occupancy atomically. Pending-row admission and retention remain deployment controls.                                                                                                                                                                                           |
| Public contract     | Malformed or privacy-expanding consumer payloads                                           | SDK V1 uses strict exact-key/date/nights/amount/arithmetic/timestamp/error decoding. Stable routes, statuses, idempotency header, pending acknowledgement, and omitted private fields are contract facts.                                                                                                                                                                                                                                                                    |
| iCalendar boundary  | SSRF, DNS rebinding, malicious redirects/content, stale data                               | HTTPS/address/redirect/body/time bounds, parser limits, provenance, reconciliation locks, and conservative stale/needs-review results. Scheduling and refresh are deployment-owned. An active external-calendar deployment must block approval until a current successful refresh or another authoritative check clears stale/needs-review state.                                                                                                                            |
| Payment boundary    | Forged/replayed/wrong-account/wrong-amount event                                           | Provider-neutral ports and bounded raw-body transport enforce signature/account/amount/currency/occupancy checks when composed. Live payment activation is intentionally off.                                                                                                                                                                                                                                                                                                |
| Secrets and backups | Repository/image/log/history/archive exposure                                              | The local `corepack pnpm scan:secrets` command checks tracked working-tree files, non-ignored untracked files, and staged index snapshots, and it redacts values. Ignored `.env`, dumps, archives, and backup directories require separate deliberate inspection and remain excluded from Git and Docker. `corepack pnpm scan:history` and repository-host scanning cover history. Deployments must encrypt, restrict, rotate, retain, and restore-test backups and secrets. |
| Deployment          | Direct Internet exposure, insecure cookies, stale image/dependencies, destructive defaults | Environment validation rejects production placeholders, requires exact admin origin/secure cookies, and Docker uses frozen installs. Reverse proxy, firewall, patching, image policy, monitoring, and resource limits remain external controls.                                                                                                                                                                                                                              |

## Abuse cases and residual risk

An attacker may guess a public property ID, submit oversized/repeated pending requests, attempt a
tenant substitution, forge a CSRF header, host a malicious calendar feed, replay a provider
event, or obtain a backup. Bounded identifiers/bodies, strict public decoding, required
idempotency, pending-only submission, scoped queries, SSRF-safe fetch, and provider checks reduce
these paths.

Residual risks include edge rate limiting, CAPTCHA or verified-contact policy, pending-row and
backup retention, password rate limiting/recovery, secret-manager implementation, mail transport,
worker/provider activation, backup key management, dependency/base-image supply chain, and
operational detection/response. The application does not claim to prevent pending-request abuse
or provide a WAF. These controls must be accepted by the deployment before production use.

## Release controls

Run the authoritative root checks and CI workflow. A green local run is evidence, not production
authorization. Before accepting traffic, the deployment owner must confirm:

- frozen install, formatter, lint, strict typecheck, unit/API/hardening tests, and the mandatory
  PostgreSQL integration gate, including repeated concurrency cases;
- architecture, public-boundary, public-contract, package, build, secret, dependency, and diff
  checks;
- `docker compose config` and `corepack pnpm docker:clean-room`; a running Docker engine is
  required, and mocked claims are not accepted;
- the local secret scan of tracked working-tree files, non-ignored untracked files, and staged
  index snapshots; separate deliberate inspection of ignored `.env`, dumps, archives, and backup
  directories without adding them to Git or Docker; and, before public release or after any
  suspected leak, `corepack pnpm scan:history` plus repository-host secret scanning; revoke or
  rotate every exposed credential and purge or rewrite history where required;
- no sample data/placeholders, exact HTTPS admin origin, secure cookies, approved TLS/reverse
  proxy/monitoring controls, and secrets from the approved manager;
- backup encryption/access/retention/recovery ownership and an explicit decision not to activate
  live Stripe, notifications, or background workers in this runtime; and
- for any deployment that activates external calendars, a current successful refresh or another
  authoritative check before approval; stale or needs-review state blocks approval.
