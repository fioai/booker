# Booking Engine extraction boundary

> **Archive note:** This file records the historical extraction context. Current maintainer
> ownership and release gates are in [`docs/architecture.md`](architecture.md),
> [`README.md`](../README.md), and `.github/workflows/ci.yml`.

Source repository: `booking-engine`
Source commit: `3f22e1149edc5153f7e1531acdf3e64b9b79b4c3`

## Included in the current repository

- the booking domain and request lifecycle;
- PostgreSQL persistence, append-only migrations, and integration tests;
- calendar and payment contracts/adapters, with live activation deferred;
- notification contracts, with transport deferred;
- the dependency-free public TypeScript SDK;
- the public API and same-origin server-rendered owner admin; and
- local Docker, hardening, boundary, package, and secret checks.

The former standalone `apps/admin` package is removed. `apps/api` owns the single listener and
the reference admin views.

## Excluded

The consumer storefront, listing configuration, media, screenshots, and discovery checks are
separate site concerns. The local engine sample is synthetic and contains no property-specific
listing or contact data.

The public SDK is the only dependency direction available to consumer sites. Private API,
database, domain, admin, provider, and worker modules remain inside this project.

## Local extraction repair record

The source Dockerfile contained a 59-character Node image digest. Docker requires a
64-character digest. The extracted Dockerfile uses the verified amd64 manifest digest for
`node:22.23.1-alpine`:

`sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605`

This was a local extraction repair. It was not applied to the original checkout. No remote,
push, deployment, credential change, or production-provider change was performed during the
historical extraction.
