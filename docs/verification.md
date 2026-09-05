# Verification guide

Use the [root release checklist](../README.md#development-and-release-gates) for commands.
This guide maps those checks to behavior; a release must rerun them on its candidate commit.
Historical implementation transcripts and old test counts remain in Git history.

| Area                   | What the checks exercise                                                                                                                | Main coverage                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property configuration | Validated canonical instances, bounded inputs, country/currency/timezone rules, and public privacy omissions                            | [Domain tests](../packages/booking-core/test/property/configuration.test.ts), [mapper tests](../apps/api/test/property/configuration/mapper.test.ts)                                                    |
| Persistence            | Tenant/property isolation, atomic writes, migration checksums, and canonical projections                                                | [PostgreSQL integration](../tests/integration/property-persistence.test.ts), [migration tests](../packages/database-postgres/test/migrations.test.ts)                                                   |
| Availability and rates | Half-open dates, minor-unit arithmetic, overrides, exclusions, and concurrent booking conflicts                                         | [Domain tests](../packages/booking-core/test/availability-rates.test.ts), [PostgreSQL tests](../tests/integration/availability-rates.test.ts)                                                           |
| Requests               | Pending public requests without inventory, immutable quotes, idempotency, approval/rejection/expiry, and transactional outbox writes    | [Lifecycle integration](../tests/integration/request-lifecycle.test.ts)                                                                                                                                 |
| Public API and SDK     | V1 routes, statuses, strict decoding, stable errors, privacy boundaries, and an independently installed SDK archive                     | [Contract tests](../packages/sdk-typescript/test/public-contract.test.ts), [API integration](../tests/integration/public-api-contract.test.ts), [SDK packaging check](../scripts/check-sdk-package.mjs) |
| Owner admin            | Authentication, membership changes, persistent sessions, CSRF/origin checks, roles, and tenant scope                                    | [Admin tests](../apps/api/test/admin), [PostgreSQL integration](../tests/integration/admin-http-postgres.test.ts)                                                                                       |
| iCalendar              | HTTPS and DNS restrictions, bounded parsing, recurrence rejection, cancellation/provenance reconciliation, export, and safe sync health | [Adapter tests](../packages/channel-ical/test/ical.test.ts), [PostgreSQL sync tests](../tests/integration/ical-sync.test.ts)                                                                            |
| Payments               | Server-owned checkout amounts, approved occupancy, raw webhook verification, event deduplication, and monotonic payment state           | [Payment integration](../tests/integration/payment-postgres.test.ts), [HTTP tests](../apps/api/test/payment/http)                                                                                       |
| Release tooling        | Environment isolation, secret scans, backup cleanup, and workspace boundaries                                                           | [Hardening tests](../tests/hardening)                                                                                                                                                                   |
| Docker                 | Production dependency packaging, startup against an empty PostgreSQL database, booking/admin smoke, and backup/restore                  | [Clean-room check](../scripts/docker-clean-room.mjs)                                                                                                                                                    |

## Boundaries that matter

The [local cabin boundary tests](../tests/hardening/cabin-demo.test.ts) cover the explicit static
asset list, rejection of untrusted Host/Origin headers, preservation of cookies/CSRF/idempotency,
and upstream failure behavior. The [example walkthrough](../examples/cabin/README.md) exercises
guest submission, persisted owner decisions and the resulting availability in a browser.

Integration tests use real PostgreSQL and isolated schemas. Docker checks build from scratch and
exercise the packaged runtime. Missing services are failures, not substituted mock evidence.
The clean-room project and its temporary data are removed after verification.

Country and currency tables are domain-owned snapshots in
[ISO 3166 data](../packages/booking-core/src/iso-3166-1-alpha-2.ts) and
[ISO 4217 data](../packages/booking-core/src/iso-4217-active.ts). Review their sources when updating
the datasets. Timezone canonicalization depends on the supported Node.js ICU/tzdata version.

Payment success records payment state after approval; payment events never acquire, release, or
change inventory. The Stripe-shaped adapter is deterministic test tooling and performs no
provider network calls. Live payment policy, notification delivery, and background workers remain
outside the activated runtime. See the [architecture](architecture.md) and
[threat model](security/threat-model.md) for deployment assumptions.
