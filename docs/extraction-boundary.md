# Booking engine extraction boundary

Source repository: `booking-engine`
Source commit: `3f22e1149edc5153f7e1531acdf3e64b9b79b4c3`

## Included

- the booking domain and request lifecycle;
- PostgreSQL persistence, migrations, and integration tests;
- calendar, notification, and payment contracts and adapters;
- the public TypeScript SDK contract;
- the public API and owner administration; and
- local Docker and hardening checks.

## Excluded

The consumer storefront, Tala listing configuration, Tala media, consumer
screenshots, and consumer discovery checks are in the separate site extraction.
The local engine sample is synthetic and contains no property-specific listing
or contact data.

The public SDK is the only dependency direction available to consumer sites.
Private API, database, and domain modules remain inside this project.

## Local repair during extraction

The source Dockerfile contained a 59-character Node image digest. Docker
requires a 64-character digest. The extracted Dockerfile uses the verified
amd64 manifest digest for `node:22.23.1-alpine`:

`sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605`

This is a local extraction repair. It was not applied to the original checkout.

No remote, push, deployment, credential change, or production-provider change
was performed. The new repository has staged files but no initial commit because
no Git author identity is configured in this environment.
