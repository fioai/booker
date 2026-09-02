# Admin authentication client guide

> **Current operational guide:** Use this procedure for every deployment-owned admin client.
> Dated verification records are historical evidence, not an operating procedure.

The admin boundary uses the same HTTPS origin as the deployed API. Keep credentials in the
deployment secret store and authentication cookies in a private client cookie store.

## Ordered client procedure

1. **Prepare the client.** Set the base URL to the exact HTTPS value configured as
   `ADMIN_ORIGIN`. Select only an authorized property identifier. Load the owner email and
   password at run time from the deployment secret store. Never put credentials, cookies, CSRF
   tokens, password hashes, or database URLs in command arguments or logs.
2. **Start the login.** Use an empty private cookie store and request `GET /admin/login`. Require
   HTTP 200 and retain the `booking_engine_admin_csrf` cookie. Send `POST /admin/login` with the
   owner email and password, the CSRF cookie, the matching `X-CSRF-Token` header, and an `Origin`
   header that exactly matches `ADMIN_ORIGIN`. Do not accept an HTTP origin or a wildcard origin.
3. **Accept the rotated session.** Require HTTP 200 and let the cookie store accept the new
   `booking_engine_admin_session` and CSRF cookies. A successful login revokes any session cookie
   that accompanied the login before it issues the new session. This rotation prevents session
   fixation. Replace the old cookies; never reuse or pin the old session. The session cookie is
   host-only, `Path=/`, `Secure`, `SameSite=Strict`, and `HttpOnly`. Do not read, export, or copy
   its value by itself. Let the private cookie store send it.
   The separate CSRF cookie is not HttpOnly because the client must copy its value to the CSRF
   header.
4. **Confirm the session.** Request `GET /admin/session` with the cookie store and require HTTP 200,
   the expected authorized user, and a valid expiry. An authenticated read does not need an
   `Origin` or CSRF header.
5. **Use only authorized property routes.** The bounded list route is
   `GET /admin/properties/{propertyId}/booking-requests`. It returns at most 100 booking requests
   across all statuses, ordered newest first. It has no pagination and no truncation marker.
   Never treat it as a complete pending queue. Recheck, approve, and reject use
   `POST /admin/properties/{propertyId}/booking-requests/{requestId}/recheck`, `/approve`, and
   `/reject`. Never substitute a property outside the operator's authorized scope. Send the
   session cookie on every route. For every POST mutation, also send the CSRF cookie, its exact
   value in `X-CSRF-Token`, and the exact HTTPS `Origin`.
6. **Check availability and the persisted result.** Treat HTTP success as transport success only.
   Preserve the recheck response. Continue to approval only when its returned
   `request.status === 'pending'` and `available === true`. Both conditions are required. If the
   deployment uses external calendars, first retain evidence of a current successful refresh or
   another authoritative availability check for every applicable source. A stale or needs-review
   source blocks approval. Stored active calendar blocks do not prove freshness. Record approval
   only when the approve response has top-level `status` equal to `approved`. Record rejection only
   when the reject response has top-level `status` equal to `rejected`. Preserve `expired`,
   conflict, and other returned states exactly; never force a transition in PostgreSQL.
7. **Log out and prove revocation.** Immediately before logout, clone the authorized client's
   opaque private cookie store into a second private cookie store. Clone the store as one protected
   object. Do not read, export, serialize, print, or place any cookie or token value in logs or
   command arguments. Keep the clone isolated from the logout response. Send `POST /admin/logout`
   with the primary store, matching CSRF cookie and `X-CSRF-Token`, and exact HTTPS `Origin`.
   Require HTTP 204 and let the primary store accept the cookie clear instructions.

   If logout has a transport failure or does not return HTTP 204, retain both stores under the same
   access controls. Use the primary store only for one additional logout attempt; do not use either
   store for another operation. If that bounded retry does not return HTTP 204, stop the procedure
   and use the controlled administrative session-revocation process. Do not destroy either store
   until that revocation is complete and independently confirmed.

   After a confirmed HTTP 204, use the isolated old store exactly once for `GET /admin/session`.
   Require HTTP 401 with `invalid_session`; this proves server-side revocation rather than only
   client-side cookie clearing. Do not retry or use the old store for another request. If this
   check fails, retain both stores under access controls and complete controlled administrative
   revocation. Destroy both private stores only after the isolated old-cookie check confirms
   revocation or controlled administrative revocation is complete and confirmed. A failed logout
   or revocation check fails the procedure.

8. **Retain redacted evidence only.** Evidence may contain the run time, release identifier,
   property and request identifiers when policy permits, HTTP results, persisted status, the
   permitted external-calendar evidence listed below, the logout result, the isolated old-cookie
   HTTP 401 result, and confirmation that both stores were destroyed. Calendar evidence may
   contain only redacted source IDs, freshness or status values, and timestamps. Never
   retain feed URLs, credentials or tokens, raw calendar content, or upstream error text in that
   evidence. If bounded retry or administrative revocation was needed, record only its result and
   treat the client procedure as failed. Redact response fields that contain guest or
   authentication data. Never retain credentials, cookies, CSRF tokens, guest names, guest contact
   data, messages, password hashes, database URLs, or raw database rows.
