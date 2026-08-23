# Threat model

## Scope and assumptions

The system is a modular monolith with a PostgreSQL persistence boundary, public
property/availability/quote/request routes, same-origin owner administration,
bounded iCalendar ingestion, an outbox, and a test-mode payment adapter. A
deployment supplies TLS termination, a secret manager, PostgreSQL access controls,
backups, monitoring, and an owner provisioning process. The local Compose password,
sample owner, Mailpit, and sample property are development fixtures only.

## Assets and boundaries

| Asset/boundary      | Main threat                                                                                                 | Controls and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant/privacy data | Cross-tenant reads or writes; operational notes or guest PII crossing public responses                      | Every repository receives an organization scope; public property is a database view/projection; admin serializes private fields only after a live session. Public contract and PostgreSQL tenant tests assert negative leakage.                                                                                                                                                                                                                                             |
| Admin auth/session  | Credential stuffing, session theft, fixation, stale membership, CSRF                                        | Password verification is injected and scrypt-backed; sessions are bounded and persisted, cookies are HttpOnly/SameSite, membership is checked on reads, logout revokes, and state changes require same-origin plus a separate CSRF token. TLS and rate limiting remain deployment responsibilities.                                                                                                                                                                         |
| Request inventory   | Two holds/occupancies overlapping under concurrency; unauthenticated request abuse                          | PostgreSQL daterange exclusion constraint remains the inventory authority. A public request-to-book requires a bounded Idempotency-Key and atomically persists a pending request plus a privacy-minimized outbox event; it does not create an active hold or other inventory row. Owner approval takes the tenant/property advisory lock, rechecks native availability and active iCalendar blocks, and inserts the authoritative occupancy under the exclusion constraint. |
| iCalendar ingestion | SSRF, DNS rebinding, malicious redirects/content, false freshness, provenance loss                          | HTTPS/host/address validation, pinned resolved addresses, bounded redirects/body/time, parser limits, source/UID/sequence provenance, a distributed property reconciliation transaction lock, PostgreSQL compare-and-set writes, and stale health surfaced to admin. An operator must not approve stale or needs-review feeds.                                                                                                                                              |
| Outbox and PII      | Duplicate delivery, leaked guest data, stuck processing                                                     | Booking and outbox insert are atomic; event uniqueness/idempotency and bounded processing states prevent duplicate transitions. Payloads/logs must be redacted, access is operationally restricted, and delivery retry/dead-letter monitoring is required.                                                                                                                                                                                                                  |
| Payment webhook     | Forged/replayed/wrong-account or wrong-amount event marks a booking paid                                    | Provider signature, timestamp/body limits, test/live/account checks, event uniqueness, metadata correlation, quote/amount/currency and approved occupancy checks. Payment is not activated for production in this slice; never use a hand-written webhook to mutate inventory.                                                                                                                                                                                              |
| Secrets             | Repository, image, logs, shell history, or backup exposure                                                  | No real Stripe/Airbnb secrets; .env and dumps are ignored; startup errors and scans withhold values; deterministic marker scan runs in CI/release gates. Secret managers, rotation, access audit, and history scanning are still required.                                                                                                                                                                                                                                  |
| Backup data         | Stolen or over-retained dump exposes PII, credentials, payment metadata, and provenance                     | Encrypt and ACL backups, use separate backup credentials, define retention/deletion approval, test restore into an isolated target, and never place archives/evidence in Git. Restore script verifies counts/invariants but cannot prove storage encryption.                                                                                                                                                                                                                |
| Deployment          | Direct Internet exposure, insecure cookies, stale image/dependencies, accidental destructive local defaults | Environment validation rejects sample data/placeholders in staging/production, requires HTTPS admin origin and secure cookies, Docker builds from the frozen lockfile without host modules, health/backup/smoke gates are documented. Reverse proxy, firewall, patching, and image digest policy remain external controls.                                                                                                                                                  |

## Abuse cases and residual risk

An attacker may guess a public property ID, submit oversized or repeated pending
requests, attempt a tenant ID substitution, forge a CSRF header, host a malicious
calendar feed, replay a provider event, or obtain a backup. Bounded identifiers/bodies,
required idempotency, pending-only public submission, stable public errors, scoped
queries, SSRF-safe fetch, trusted webhook verification, and backup access controls
reduce these paths. A stale reconciliation CAS is surfaced as needs-review and cannot
release or overwrite a newer PostgreSQL row.

Residual risks include production reverse-proxy/header configuration, edge request
rate limiting, CAPTCHA or verified-contact policy if required by the deployment,
durable database/outbox admission and retention controls, password rate limiting and
account recovery policy, secret-manager implementation, mail transport security,
backup key management, dependency/base image supply-chain policy, and operational
detection/response. The application guarantees that an unauthenticated public request
cannot block inventory, but it does not claim to prevent pending-row or outbox spam.
The application does not implement an external WAF, CAPTCHA, verified-contact flow,
or edge limiter. These controls and resource protections must be accepted and owned
by the deployment operator before production use; this card does not activate
production Stripe, create real Airbnb/iCalendar connections, or broaden the
architecture to address unrelated findings.

## Adam-controlled production gates

Adam is the named release approver for this slice. A green local or clean-room run is
evidence for review, not production authorization. Adam must confirm every release
gate below before approving traffic:

- frozen install, formatter, zero-warning lint, strict typecheck, unit/API/hardening
  tests, PostgreSQL integration with repeated concurrency, and real Chromium E2E;
- public boundary and public contract checks, build, Docker Compose configuration,
  no-cache/pull clean-room smoke, and a real isolated backup/restore rehearsal;
- dependency audit, deterministic secret scan, and `git diff --check`, with no
  generated logs, dumps, environment details, secrets, or Hermes evidence staged;
- production environment review: no sample data or local placeholders, HTTPS admin
  origin, secure cookies, approved reverse-proxy/TLS and monitoring controls, and
  secrets loaded from the approved manager; and
- backup encryption/access/retention and recovery ownership, plus an explicit decision
  that this slice has not activated live Stripe or real Airbnb/iCalendar credentials.

Any missing, stale, or unverifiable item is a release blocker for Adam. The same gate
applies after a rollback or material configuration change.
