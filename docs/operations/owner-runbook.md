# Owner runbook

> **Current runtime:** The owner admin is the same-origin, server-rendered reference surface in
> `apps/api`. This runbook does not imply an active worker, notification transport, live payment
> provider, or background iCalendar scheduler.

Guest PII is visible only on the authenticated admin boundary. Public responses intentionally
return a request identifier, dates, status, and quote, but not guest name, email, or message.

## Daily checks

Check the process probe and, after exporting the deployment environment, validate the database
configuration separately:

```sh
curl --fail http://127.0.0.1:13000/healthz
corepack pnpm check:env:runtime
```

Review pending requests and current persisted availability in the admin boundary. If an external
calendar or payment integration is operated by the deployment, treat its stale/failed status as
an operational hold and follow that deployment's runbook; this repository does not run a
background sync or notification worker.

## Request-to-book workflow

1. Open the request through the authenticated `/admin` boundary and confirm property, dates,
   guest count, and the server quote.
2. Use the CSRF-protected recheck action immediately before deciding. The PostgreSQL
   tenant/property lock and exclusion constraint protect the concurrent occupancy write.
3. Approve only when the recheck reports available. Approval rechecks native availability and
   active iCalendar blocks, then promotes a real hold or inserts occupancy for a public pending
   request. A conflict leaves the request pending.
4. Reject a request that cannot be honored. Do not edit PostgreSQL rows manually to force a
   status transition.
5. A public request-to-book must include a bounded `Idempotency-Key`. A retry with the same key
   returns the original request; changed data is a conflict. Public submission creates a pending
   request and does not reserve dates.
6. Configure reverse-proxy rate, connection, abuse, contact-verification, and pending-row
   resource controls separately. The application does not implement a WAF, CAPTCHA, or external
   rate-limit provider.

Repeat the disposable local smoke only with Docker:

```sh
corepack pnpm docker:clean-room
```

## Authentication and privacy

Use HTTPS in deployed environments. Admin session cookies are HttpOnly and SameSite; state
changes require exact-origin checks plus a separate CSRF token. Log out after use and revoke an
owner membership through the controlled owner-management process when an operator leaves.

Do not paste guest names, emails, messages, cookies, password hashes, database URLs, calendar
URLs, or webhook signatures into tickets or chat. If a public response contains PII, stop traffic
and preserve only a redacted status/request ID for investigation.

## Incident actions

- **Database unavailable:** keep the public boundary out of rotation, preserve the last known
  backup, and restore only after migration/checksum and read-only checks succeed.
- **Overlap or approval conflict:** do not retry blindly. Recheck the request and inspect active
  occupancy/hold rows for that property through the authenticated boundary.
- **Stale external calendar:** stop approving affected dates and follow the deployment-owned
  integration procedure. Never replace a feed with an arbitrary URL to make a request pass.
- **Suspicious payment webhook:** live payment is not activated by this runtime. Do not mark a
  payment paid manually; require the deployment's provider verification and occupancy checks.
- **Credential exposure:** revoke the affected membership/session and rotate the external secret.
  Do not delete guest data as a first response.

## Maintenance

Before a release run the frozen install, formatter, zero-warning lint, strict typecheck, unit/API
and hardening tests, PostgreSQL integration when available, build, architecture/public-boundary/
public-contract/package checks, environment check, secret scan, dependency audit, and
`git diff --check`. Keep backups and generated logs outside Git.
