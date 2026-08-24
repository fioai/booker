# Booking Engine

This directory is the extracted reusable booking engine for rental properties.
It is a local, non-production extraction from the original `booking-engine`
repository. The original repository remains the source history.

## Boundary

The engine owns:

- `apps/api/` — public booking API, owner administration, and runtime composition;
- `apps/admin/` — SDK-only owner administration consumer;
- `packages/booking-core/` — property and booking domain rules;
- `packages/database-postgres/` — PostgreSQL persistence and migrations;
- `packages/payments/` and `packages/payments-stripe/` — payment contracts and adapter;
- `packages/channel-calendar/` and `packages/channel-ical/` — calendar contracts and adapter;
- `packages/notifications/` — notification contracts;
- `packages/sdk-typescript/` — the versioned public consumer contract; and
- `packages/test-support/` — deterministic test support.

The consumer site is not part of this directory. It is extracted to a separate
sibling project. Consumer applications must use the public SDK only. They must
not import private API or database modules.

The local sample property is synthetic. It contains no consumer listing facts,
contact details, or consumer media.

## Prerequisites

- Node.js `v22.23.1` or a compatible `22.x` release;
- Corepack-enabled pnpm `10.12.1`; and
- Docker for database-backed checks.

## Install

```text
corepack pnpm install --frozen-lockfile
```

## Verification

```text
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm check:public-contract
corepack pnpm check:env
corepack pnpm scan:secrets
```

`docker:clean-room` needs a running Docker engine. It creates isolated local
resources, runs the API request-to-book smoke, and removes its temporary
resources. It does not deploy the engine.

## Owner gates

This extraction does not approve production deployment, credentials, payment
activation, public publication, or legal commitments. Those actions require
Adam's approval. Consumer content and media licensing remain in the
separate site project and require the recorded owner and legal review.
