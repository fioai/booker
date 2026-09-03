# Owner runbook

> **Current runtime:** `GET /admin` is the same-origin, server-rendered landing and reference
> surface in `apps/api`. It cannot list, recheck, approve, or reject booking requests. This runbook
> does not imply an active worker, notification transport, live payment provider, or background
> iCalendar scheduler.

Guest PII is visible only on the authenticated admin boundary. Public responses intentionally
return a request identifier, dates, status, and quote, but not guest name, email, or message.

## Daily checks

Export the deployment environment, then run these checks in order:

```sh
curl --fail http://127.0.0.1:13000/healthz
corepack pnpm check:env:runtime
corepack pnpm check:database
```

Treat a failed `check:database` command as a database-unavailable condition. The repository probe
reads its credentials from the environment and issues only `SELECT 1`. Success confirms that the
database is reachable and accepts a read-only query; it does not confirm the schema or migrations.

`GET /admin` is an authenticated HTML landing page. It cannot perform booking-request decisions.
Use a deployment-owned authorized client and follow the current
[admin authentication client guide](admin-auth.md) for login, session rotation, cookie handling,
property-scoped routes, mutation protection, persisted-status checks, logout, and redacted
evidence. Do not copy authentication values into commands, tickets, or chat.

A production deployment must provide a deployment-owned complete pending-work queue or monitor.
The latest-100 list in the guide must not be its sole source of pending work. This repository does
not ship a complete human request-management client.

Use the deployment-owned queue or monitor to select pending work, and recheck availability
immediately before each decision. If the deployment activates external calendars, complete a
current successful refresh or another authoritative availability check before approval. A stale
or needs-review state blocks approval. The deployment owns this control because this repository
does not run a background calendar sync, notification worker, or payment worker.

## Request-to-book workflow

1. Select a pending request from the deployment-owned complete queue or monitor. Confirm the
   property, dates, guest count, and server quote.
2. If the deployment activates external calendars, complete a current successful refresh or
   another authoritative availability check for each applicable source. Continue only when no
   stale or needs-review state remains. Do not infer freshness from stored active blocks.
3. Call the CSRF-protected recheck endpoint immediately before deciding. The PostgreSQL
   tenant/property lock and exclusion constraint protect the concurrent occupancy write.
4. Preserve the returned `request.status`; recheck can return `expired`. Continue only if the
   returned request is still `pending`. Keep it pending only when availability remains unresolved.
   Never replace an `expired` or other returned lifecycle state with `pending`.
5. Approve only when the external-calendar control above has passed and recheck returns
   `request.status === 'pending'` and `available === true`. Approval rechecks native availability
   and active iCalendar blocks, then promotes a real hold or inserts occupancy for a public pending
   request.
   A conflict leaves a still-pending request pending. After calling approve, require both HTTP
   success and a returned persisted top-level `status` of `approved` before recording approval.
6. Reject a pending request that cannot be honored. After calling reject, require both HTTP success
   and a returned persisted top-level `status` of `rejected` before recording rejection. An expiry
   race can make either decision endpoint return `expired`. Record the exact returned state. Do not
   claim approval or rejection unless the returned state is exactly `approved` or `rejected`,
   respectively. Do not edit PostgreSQL rows manually to force a status transition.
7. A public request-to-book must include a bounded `Idempotency-Key`. A retry with the same key
   returns the original request; changed data is a conflict. Public submission creates a pending
   request and does not reserve dates.
8. Configure reverse-proxy rate, connection, abuse, contact-verification, and pending-row resource
   controls separately. The application does not implement a WAF, CAPTCHA, or external rate-limit
   provider.

Admission limits must bound both accepted pending booking requests and the `booking_outbox` rows
that those requests produce. Monitor the count, arrival rate, and oldest age of pending requests.
Also monitor outbox count, growth, oldest age, status, and delivery attempts. No outbox worker is
active in this release. Production exposure requires admission limits, monitoring and alerts, and
a deployment-owned, reviewed delivery and retention policy for `booking_outbox`.

The current schema cascades deletion of a `booking_requests` row to its linked `booking_outbox`
rows. Before deleting a booking request, copy every record required by the audit and retention
policy to an approved independent retention store and verify the copy. If the copy or verification
fails, do not delete the request. Do not treat linked outbox rows as audit copies that survive the
request.

The authoritative root
[release checklist](../../README.md#development-and-release-gates) includes the mandatory Docker
clean-room gate. It runs the local-only `scripts/smoke-request-to-book.mjs` protocol exercise. That
script is not a human request-management client or an operator tool. Never use it against a
deployed environment.

## Authentication and privacy

Use HTTPS and follow the [admin authentication client guide](admin-auth.md) through its logout and
revocation check. Revoke an owner membership through the controlled owner-management process when
an operator leaves.

Do not paste guest names, emails, messages, cookies, password hashes, database URLs, calendar
URLs, or webhook signatures into tickets or chat. If a public response contains PII, stop traffic
and preserve only a redacted status/request ID for investigation.

The local `corepack pnpm scan:secrets` command scans three local sources: tracked worktree files,
non-ignored untracked files, and staged index snapshots. It does not scan ignored files. Before a
public release and after any suspected credential leak, use a separate access-controlled process
to inspect ignored `.env` files, database dumps, archives, and backup directories. Also run
`corepack pnpm scan:history` and repository-host secret scanning. Revoke or rotate every exposed
credential. Purge or rewrite history where required; a history rewrite does not replace credential
revocation or rotation.

## Incident actions

- **Database unavailable:** Remove the public boundary from rotation. Preserve the last known
  backup. Restore service only after migration, checksum, and read-only checks succeed.
- **Overlap or approval conflict:** Stop the approval attempt and recheck the request. Preserve the
  returned lifecycle state. Keep it pending only when the returned request is still pending and
  availability remains unresolved. Escalate through the deployment-owned DBA procedure. The DBA
  must use a separately provisioned read-only credential, never the application `DATABASE_URL`,
  inspect the occupancy and hold records in an explicit read-only transaction, and retain the
  authorization, query text, timestamp, and redacted results as audit evidence. Never insert,
  update, or delete occupancy or hold rows manually.
- **Deployment-operated external calendar issue:** Stop approvals for affected dates while any
  source is stale or needs review. Follow the deployment-owned integration procedure and resume
  only after a current successful refresh or another authoritative availability check clears the
  state. Do not replace a feed with an arbitrary URL.
- **Unexpected payment webhook:** This runtime has no live payment provider. Do not change payment
  or occupancy data. Preserve redacted request metadata and use the deployment incident process.
- **Credential exposure:** Revoke every exposed membership or session and rotate every exposed
  external credential. Run `corepack pnpm scan:history` and repository-host secret scanning, then
  purge or rewrite history where required. The local worktree/index scan is not history evidence.
  Do not delete guest data as a first response.

## Maintenance

The root [development and release gates](../../README.md#development-and-release-gates) checklist
is the single authoritative release command list. PostgreSQL integration and Docker clean-room are
mandatory. An unavailable required service or Docker engine blocks release; mocked evidence does
not replace either gate. Do not copy a partial checklist into this runbook.

The runtime does not start an expired-hold worker. If the deployment activates this maintenance,
its reviewed adapter must call `releaseExpiredHolds` for one approved organization scope at a time.
This path is an intentional tenant-wide exception: it scans properties with expired active holds
inside that organization, then takes the organization/property advisory lock before it mutates
each property. Do not replace it with a global or unlocked update. Stop on a scope or lock failure.
Retain the organization identifier, cutoff time, returned release count, and redacted result as
maintenance evidence.

The owner must also retain these deployment records for each release:

- Backup and restore evidence stored outside Git: the backup identifier, release and database
  scope, completion time, restore-rehearsal result, and redacted read-only verification result.
- The redacted staging and production database identity, including host or cluster, port,
  database, user, and the effective `DATABASE_SCHEMA`, stored with the ordered migration IDs and
  SHA-256 checksums. Record `public` when the runtime default is effective.
- Redacted evidence stored outside Git from each required
  [non-destructive deployment-smoke contract](../deployment/self-host.md#non-destructive-deployment-smoke-contract)
  run. It must include the persistence no-change check and the full admin-auth result: logout,
  isolated old-cookie HTTP 401 `invalid_session` proof, confirmed cookie-store destruction, and no
  authentication values.
- For production, the write-drain deadline and result, reconciliation of every in-flight write,
  final backup, candidate and health results, acceptance while writes remained drained, and the
  separate traffic-restore approval.
