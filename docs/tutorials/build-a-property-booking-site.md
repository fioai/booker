# Build a custom property booking flow

A rental website needs more than a contact form: guests need a price for specific dates, and
owners need a decision workflow that protects availability. This tutorial walks through the
[Juniper Cabin example](../../examples/cabin/README.md), using Booking Engine's V1 client.

The example runs against PostgreSQL. It collects no payment and sends no email. The runtime is
prerelease; use fictional details while evaluating it.

## Start with a working property

Run the [Quickstart](../../README.md#quickstart) and open the cabin page. It seeds a two-guest
property at CAD 125 per night, with a two-night minimum and no cleaning fee. The fixture ID is
`sample-bungalow`.

The browser loads the compiled public SDK from `/sdk/index.js`. In an application using the
packed SDK, import from `@booking-engine/sdk-typescript` instead. Registry installation is not
available until publication; the [SDK guide](../../packages/sdk-typescript/README.md) explains the
local tarball workflow.

```js
import { createBookingEngineClientV1 } from '/sdk/index.js';

const client = createBookingEngineClientV1({
  baseUrl: window.location.origin,
  defaultPropertyId: 'sample-bungalow',
});
const property = await client.getPublicProperty();
```

Render the returned summary, guest capacity, amenities and host notes. Property photos and page
design belong to your frontend. Guest-facing property responses omit private operational notes.

## Check the dates and show the quote

Keep dates as `YYYY-MM-DD` calendar strings in the property's timezone. Check-out is exclusive:
a stay from October 10 to October 12 occupies two nights. Choose future, available dates when
running this example.

```js
const stay = { arrival: '2026-10-10', departure: '2026-10-12' };
const [availability, quote] = await Promise.all([
  client.getAvailability(property.id, stay),
  client.getQuote(property.id, stay),
]);

if (!availability.available) {
  // Ask the guest to choose other dates. Do not enable submission.
} else {
  const total = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: quote.currency,
  }).format(quote.totalMinor / 100);
  console.log(`${quote.nights} nights: ${total}`);
}
```

The quote includes each night's rate, the nightly subtotal, cleaning fee, total and minimum stay.
Use the server quote; do not recreate pricing in the browser. Minimum-stay failures reject the
SDK promise. Changing either date must invalidate the visible quote. The example also discards
old responses if the guest edits their dates while a check is in flight.

Availability is a snapshot. Another guest may secure the dates before this request is approved.

## Submit one logical request

Create an idempotency key once for the guest's chosen input, and retain it for retries of that
same input. Generating a new key on every retry can produce duplicate requests when the first
response was lost after the server saved it.

```js
const input = {
  ...stay,
  guestCount: 2,
  guestName: 'Alex Morgan',
  guestEmail: 'alex@example.test',
  message: 'A quiet weekend in the garden.',
};
const options = { idempotencyKey: crypto.randomUUID() };
const request = await client.requestToBook(property.id, input, options);
console.log(request.status);
```

On a transient failure, retry `requestToBook(property.id, input, options)` with those same values.
For a new intended request, use a new key. The example keeps both input and key in memory, and
disables the submit button while sending. It does not store guest contact details in browser
storage or put them in URLs.

An initial successful request is pending. It does not hold inventory. Treat the returned lifecycle
as authoritative: retrying an existing request may return approved, rejected or expired.

## Let the owner decide

Open the example owner inbox in a second tab, use its local sample login, and review the request.
This is a separate admin HTTP client. Owner credentials never belong in your guest SDK calls.

The example uses the existing session cookie and double-submit CSRF protection. Approval follows
these steps:

1. POST to the request's `/recheck` route.
2. Continue only if `request.status === 'pending'` and `available === true`.
3. POST to `/approve`. The backend checks availability again while writing occupancy.
4. GET the request and display its persisted status. HTTP 200 alone is not proof of approval.

See [public/owner.js](../../examples/cabin/public/owner.js) for the implementation and the
[admin guide](../operations/admin-auth.md) for the full operational protocol. The demo has no
external calendars; a real deployment must also enforce their freshness before approving.

## Prove the result

Return to the original guest tab and select **Refresh decision**. V1 returns the saved lifecycle
when the same input and idempotency key are replayed; it does not expose a public lookup route
containing guest details. The tab should now show approved.

Start another request for the same dates. Availability should now be false. Try a fresh date
range and decline it from the owner tab: declining should leave those dates unreserved.

That is the boundary the example demonstrates: your frontend owns the experience; the engine
owns pricing, request state and occupancy. Before using real guests, address the runtime and
operational limitations in the [self-host guide](../deployment/self-host.md).
