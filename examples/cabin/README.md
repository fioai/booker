# Juniper Cabin example

A custom property website backed by the real Booking Engine API and PostgreSQL. The guest page
uses the public TypeScript SDK; the owner inbox uses the existing authenticated, CSRF-protected
admin routes. Plain HTML, CSS and browser modules; no frontend framework or new dependencies.

![Juniper Cabin guest website](../../docs/images/cabin-demo.jpg)

## Run it

Follow the root [Quickstart](../../README.md#quickstart), then open
[Juniper Cabin](http://127.0.0.1:13001). `corepack pnpm demo` builds the SDK and starts the example
server. Keep that terminal open and leave the Compose API running.

1. Choose an available stay of at least two nights and select **Check availability**.
2. Review the quote, select **Use sample details**, then **Request to book**.
3. Open **Try the owner side** in its separate tab.
4. Select **Use local demo login**, then **Sign in**.
5. Select **Check & approve**. The client rechecks availability and reads the saved decision back.
6. Return to the guest tab and select **Refresh decision**. It should show **approved**.
7. Start another request for the same dates. They should now be unavailable.

Declining a different sample request leaves its dates unreserved. Multiple pending requests may
overlap; approval is the point at which occupancy is created. Reloading the page forgets its
in-memory retry key and guest details, so keep the guest tab open while trying the owner flow.

The public fixture credentials are `sample-owner@example.test` / `local-only-owner-password`.
They work only with the seeded local quickstart. The property keeps the stable fixture ID
`sample-bungalow`; its display name is Juniper Cabin.

## Ports and troubleshooting

The example defaults to port `13001`, proxying the API at `127.0.0.1:13000`. For other ports:

```sh
corepack pnpm demo --port 13002 --api-port 13003
```

The API's `ADMIN_ORIGIN` must match its own loopback URL, including the API port. The example
validates the browser's exact Origin and Host, then translates that approved origin for the API.
Use the printed `127.0.0.1` URL, including for sign-in; `localhost` is intentionally rejected.
No wildcard CORS or authentication bypass is involved.

If the property cannot load, check the Compose app's health and sample seed. If dates are
unavailable after trying approval, choose fresh dates; restarting the app preserves requests in
PostgreSQL. If the SDK cannot load, run `corepack pnpm build` from the repository root.

Ctrl+C stops the example server. `docker compose stop` stops the quickstart services and keeps
their database volume. Use a new Compose project and unused ports for a fresh database.

## Scope

This is a **local developer demo**, with fictional property and guest details and a freely reusable cabin photograph.
Its server binds to loopback, serves an explicit asset allowlist, and never serves the repository
root. It is separate from the production API image.

The owner inbox shows only the latest 100 requests across all statuses. It has no complete queue,
pagination, external-calendar freshness controls, email delivery, or payments. For a real
deployment, follow the [owner runbook](../../docs/operations/owner-runbook.md) and
[self-host guide](../../docs/deployment/self-host.md).

Do not tunnel this local sample owner account onto the public internet. A shared public demo
needs isolated visitor data, bounded retention and abuse controls.

## Source map

| File                                   | Purpose                                                |
| -------------------------------------- | ------------------------------------------------------ |
| [public/guest.js](public/guest.js)     | SDK calls, quotes, retry keys and guest request states |
| [public/owner.js](public/owner.js)     | Same-origin login, inbox and persisted decisions       |
| [server.mjs](server.mjs)               | Local static server and restricted API proxy           |
| [public/styles.css](public/styles.css) | Responsive styles shared by the two pages              |

## Photograph

[public/cabin.jpg](public/cabin.jpg) is an unmodified photograph of Pinecone Cottage at Evergreen
Dorrington in California, by **Bobbyvaughnevergreen**, dated 1 April 2025. The photographer released
it under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), permitting copying,
modification and commercial use without requesting permission.

[Original and license record on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Evergreen_Dorrington_Pinecone_Cottage_exterior.jpg).
Retrieved on 2026-09-05. The original JPEG is bundled locally, so the demo needs no third-party
image request. The photo is illustrative: Juniper Cabin's name, location and booking data are
fictional and do not describe or offer bookings at the photographed property.

The page's name, description and host notes come from the public property API, and its guest
selector follows the property's capacity. The photograph is an example-site asset; it is not
part of the V1 property contract.
