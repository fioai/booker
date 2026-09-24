# `@fiolabs/booking-engine`

Dependency-free TypeScript client for the Booking Engine V1 public HTTP contract.

Connect a JavaScript or TypeScript storefront to a separately hosted Booking Engine backend.
The backend's deployment instructions are in the
[self-hosting guide](https://github.com/fioai/booker/blob/main/docs/deployment/self-host.md).

> **Release status:** Version `0.1.0` is an unpublished release candidate. It is not available from
> a registry until the `v0.1.0` tag is created and the package is published with provenance. The
> Booking Engine runtime is pre-release and is not recommended for production traffic. See the
> [release guide](https://github.com/fioai/booker/blob/main/RELEASING.md) for the complete SDK release procedure.

## Install after publication

```sh
npm install @fiolabs/booking-engine
```

The package has no workspace or runtime package dependencies. It works in Node.js and browsers
with the platform `fetch`, or with an injected fetch implementation.

## Create a client

```ts
import { createBookingEngineClientV1 } from '@fiolabs/booking-engine';

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

For environments without a global `fetch`, the consumer must install or provide a fetch
implementation. For example, install `undici` in the consumer project, then inject its named
`fetch` function:

```ts
import { fetch as undiciFetch } from 'undici';

import { createBookingEngineClientV1 } from '@fiolabs/booking-engine';

const client = createBookingEngineClientV1({
  baseUrl: 'https://booking.example.test',
  fetch: undiciFetch,
});
```

## Supported V1 operations

- `getPublicProperty(propertyId)` / `getProperty(propertyId)`;
- `getAvailability(propertyId, { arrival, departure })`;
- `getAvailabilityMonth(propertyId, { month: '2028-02' })`;
- `getQuote(propertyId, { arrival, departure })`;
- `requestToBook(propertyId, input, { idempotencyKey })`.

Request-to-book options are required. The idempotency key is sent in the `Idempotency-Key`
header and is never added to the JSON body. A first successful request creates a pending request.
An idempotent replay returns the existing request with its current lifecycle status. Guest
contact fields, tenant identifiers, operational notes, and other private fields are not part of
the response.

All local-date intervals are half-open (`[arrival, departure)`) and money values are integer
minor units. Invalid responses and error payloads fail closed as `BookingEngineApiErrorV1`;
client-side input failures are `PublicContractValidationErrorV1`.

## Monthly availability

`GET /v1/properties/{propertyId}/availability/month?month=YYYY-MM` returns
`{ propertyId, month, days: [{ date, available }], checkedAt }`. It includes every night in
that property-local month in date order (28–31 entries), using one bulk inventory read.
Months must be in years 0001–9998. Active manual blocks, holds, confirmed occupancy and
imported iCalendar blocks are included; released blocks are excluded. Each flag covers
`[date, following date)`, so a booked check-in day can still be another guest's check-out.

Only date flags are public; no guest details, block reasons or source identifiers are returned.
`checkedAt` is the start of the read, for bounded snapshot caching. This is advisory inventory,
not a reservation or a quote. Continue to check availability, rates and stay rules through the
normal quote and request flow. Deploy a backend containing this endpoint before using the
new client method; older servers return a route error.

## Public/private boundary

This SDK is the only intended public package in the first `0.1.x` release line. The repository's
domain, PostgreSQL, payment, calendar, notification, and admin packages remain private
implementation boundaries. External storefronts should use the versioned HTTP contract through
this package and must not import server or database internals.
