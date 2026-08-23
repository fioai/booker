# Owner runbook

This runbook is for an authorized owner or operator of a self-hosted Lotus Booking
instance. Guest PII is visible only on the authenticated admin boundary. Public
responses intentionally return a request identifier, dates, status, and quote but
not guest name, email, or message.

## Daily checks

Check the app probe and, after exporting the deployment environment, validate the
database connection configuration. `/healthz` is a process probe, so use the deployment
monitor or an approved `pg_isready`/read-only query separately for database connectivity:

    curl.exe --fail http://127.0.0.1:13000/healthz
    corepack.cmd pnpm check:env:runtime

In the admin UI, review pending booking requests, stale iCalendar sources, and
outbox delivery failures. A stale source is not proof that dates are free. Treat a
stale or failed source as an operational hold until the source is repaired and the
request is rechecked.

## Request-to-book workflow

1. Open the request from the authenticated /admin boundary and confirm property,
   dates, guest count, and the server quote.
2. Use the CSRF-protected recheck action immediately before deciding. The
   PostgreSQL property lock and exclusion constraint protect the concurrent
   occupancy write; the recheck also considers persisted iCalendar blocks.
3. Approve only when the recheck reports available. Approval atomically rechecks
   native availability and iCalendar blocks, then promotes an internal hold or
   inserts confirmed occupancy for a public pending request and emits the approval
   outbox event. A conflict leaves the request pending.
4. Reject a request that cannot be honored. Do not edit PostgreSQL rows manually to
   force a status transition.
5. A public request-to-book must include a bounded `Idempotency-Key`; a retry with
   the same key returns the original request. A reuse of the key with different
   request data is a conflict and requires a new guest submission. Public submission
   creates a pending request and privacy-minimized outbox event only; it does not
   reserve dates. The idempotency key supports safe retries but is not an abuse
   control.

6. Configure the trusted reverse proxy's request-rate, connection, and abuse
   controls, pending-row/outbox resource limits, and any contact verification
   separately. This application-level repair does not implement a WAF, CAPTCHA,
   verified-contact flow, or external rate-limit provider.

The clean-room exercise can be repeated against a disposable local project:

    corepack.cmd pnpm docker:clean-room

It uses only the documented local fixture and dates, never a real guest or provider.

## Authentication and privacy

Use HTTPS in deployed environments. Admin session cookies are HttpOnly and
SameSite; the CSRF token is separate and state-changing routes require the
same-origin check plus the CSRF token. Log out after use and revoke a membership
through the controlled owner-management process when an operator leaves.

Do not paste guest names, emails, request messages, cookies, password hashes,
database URLs, iCalendar URLs, or webhook signatures into tickets or chat. If a
request appears in a public response with PII, stop traffic and preserve only the
redacted response status/request ID for investigation.

## Incident actions

- Database unavailable: keep the public boundary out of rotation, preserve the
  last known backup, and restore service only after migrations and a read-only
  count check succeed.
- Overlapping booking or approval conflict: do not retry approval blindly.
  Recheck the request, inspect active occupancy/hold rows for that property, and
  resolve through the admin boundary.
- Stale iCalendar: stop approving affected dates, verify the source URL and
  provenance, then run the bounded sync job. A reconciliation CAS loss is
  conservative `needs-review`; inspect the newer persisted event/block before
  retrying. Never replace an external feed with an arbitrary URL to make a request
  pass.
- Suspicious payment webhook: do not mark a payment paid manually. Require
  provider signature, account, event, amount, currency, and request/occupancy
  correlation checks; quarantine the event and rotate the webhook secret through
  the secret manager if trust is uncertain.
- Credential exposure: revoke the affected owner membership/session and rotate
  the external secret. Do not delete guest data as a first response.

## Maintenance

Run the frozen install, all application/integration tests, zero-warning lint,
strict typecheck, build, boundary checks, dependency audit, deterministic secret
scan, and backup/restore check before a release. Keep backup evidence and generated
logs outside Git; the .hermes-hardening-\* files are local verification evidence
and must remain uncommitted.
