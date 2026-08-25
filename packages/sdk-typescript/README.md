# `@booking-engine/sdk-typescript`

Dependency-free TypeScript client for the Booking Engine V1 public HTTP contract.

## Install

```sh
pnpm add @booking-engine/sdk-typescript
```

The package has no workspace or runtime package dependencies. It works in Node.js and browsers
with the platform `fetch`, or with an injected fetch implementation.

## Create a client

```ts
import { createBookingEngineClientV1 } from '@booking-engine/sdk-typescript';

const client = createBookingEngineClientV1({
  baseUrl: 'https://booking.example.test',
  defaultPropertyId: 'sample-bungalow',
});

const property = await client.getPublicProperty();
const availability = await client.getAvailability(property.id, {
  arrival: '2026-08-01',
  departure: '2026-08-03',
});
```

For environments without a global `fetch`, inject one:

```ts
const client = createBookingEngineClientV1({
  baseUrl: 'https://booking.example.test',
  fetch: (url, init) => fetch(url, init),
});
```

## Supported V1 operations

- `getPublicProperty(propertyId)` / `getProperty(propertyId)`;
- `getAvailability(propertyId, { arrival, departure })`;
- `getQuote(propertyId, { arrival, departure })`;
- `requestToBook(propertyId, input, { idempotencyKey })`.

Request-to-book options are required. The idempotency key is sent in the `Idempotency-Key`
header and is never added to the JSON body. A successful request acknowledges a public pending
request; guest contact fields, tenant identifiers, operational notes, and other private fields
are not part of the response.

All local-date intervals are half-open (`[arrival, departure)`) and money values are integer
minor units. Invalid responses and error payloads fail closed as `BookingEngineApiErrorV1`;
client-side input failures are `PublicContractValidationErrorV1`.

## Public/private boundary

This SDK is the only public package in the first `0.1.x` release line. The repository's domain,
PostgreSQL, payment, calendar, notification, and admin packages remain private implementation
boundaries. External storefronts should use the versioned HTTP contract through this package and
must not import server or database internals.
