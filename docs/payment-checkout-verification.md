> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Payment checkout verification

This slice adds provider-neutral checkout contracts, a PostgreSQL payment state boundary,
and a bounded Stripe-shaped adapter that runs in test mode only. It is explicitly a
post-approval payment-recording baseline: it does not use Stripe keys, call Stripe, activate
production payments, or decide host payment/refund policy.

## Server-owned checkout

The checkout endpoint is:

```text
POST /v1/properties/{propertyId}/booking-requests/{requestId}/checkout
```

The request body is empty. The trusted composition boundary supplies the tenant scope. The
server locks the approved request and requires its exact inventory record to be an active
`occupancy`. Approval already owns the request lifecycle transition from its initial hold to
that active occupancy; checkout does not accept a hold as an alternative and does not change
inventory. Amount, currency, organization, property, request, inventory-record identifier,
and immutable quote revision come from the server transaction. Approval either promotes an
internal request hold or creates the occupancy for a public pending request before checkout.
Browser-supplied payment
fields are rejected. The browser return URL is not payment authority; only a verified
provider event can advance payment state.

Webhook requests are verified against the exact raw bytes received by the HTTP server. The
body and timestamp tolerance are bounded, and signature, provider account, session, payment,
amount, currency, and metadata are checked before payment state changes. Provider event IDs
are unique in PostgreSQL. Webhook processing is provider/account/session/metadata-bound and
does not use a browser tenant.

## Post-approval payment recording

A valid success event records the payment as paid while the approved occupancy remains active.
Failed and expired events record only their payment state and leave the approved occupancy
active. Payment events never promote, release, or otherwise mutate inventory. Missing,
released, or non-occupancy inventory fails closed: checkout cannot start, and a webhook event
does not change the payment or inventory state. Delayed, out-of-order, mismatched, duplicate,
and terminal events remain bounded and monotonic.

The adapter returns deterministic `checkout.stripe.test` URLs and never performs network I/O.
Secrets and raw webhook payloads are not persisted or returned in errors.

## Production activation boundary

Live payment activation remains disabled. Before a production adapter or deployment is
considered, deployment owners must provide and approve all of the following:

- the Stripe test/live account and connected-account ownership model;
- the verified webhook endpoint, signing-secret provisioning, key rotation, and retry policy;
- the host payment, refund, cancellation, chargeback, dispute, and reconciliation policy;
- supported settlement currencies, tax/accounting treatment, and receipt requirements;
- confirmation of the approved-inventory ownership and operational monitoring model;
- explicit production-risk approval and a plan for secret storage and deployment.

Until those inputs exist, only the deterministic test-mode adapter and local PostgreSQL
integration coverage may be used. No real Stripe key or network call should be added to this
repository as a substitute for the missing policy.
