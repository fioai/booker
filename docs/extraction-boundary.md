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
64-character digest. Both stages in the current Dockerfile use the verified multi-platform OCI
index digest for `node:22.23.1-alpine`:

`sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2`

Docker Hub registry metadata identifies that digest as the index for Linux `amd64`, `arm/v6`,
`arm/v7`, `arm64/v8`, and `s390x` images. Docker selects the matching platform manifest from
the pinned index. This replaces the earlier local repair that pinned only the `amd64` manifest
and preserves the same Node tag.
