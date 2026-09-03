# Changelog

All notable user-visible changes are recorded here. The public SDK follows the version and tag
rules in [`RELEASING.md`](RELEASING.md).

## Unreleased

## 0.1.0 - 2026-09-03

- First public SDK release: `@booking-engine/sdk-typescript` is a dependency-free TypeScript client
  for the versioned Booking Engine V1 public HTTP contract, with property, availability, quote,
  and request-to-book operations.
- The SDK keeps request-to-book idempotency in the `Idempotency-Key` header, uses half-open
  local-date intervals and integer minor-unit money values, and fails closed on invalid responses
  and error payloads.
- Release hardening adds tag and source verification, pinned GitHub Actions tooling, frozen
  dependency installation, SDK package and archive checks, secret scanning, npm version checks,
  and npm provenance publication with protection against republishing an existing version.
- Booking Engine runtime remains pre-release and is not recommended for production traffic.

## Release entry rules

Each published SDK version gets a dated section named `X.Y.Z`. Record added, changed, fixed,
security, and deprecated behavior, plus migration instructions when relevant. Move entries from
`Unreleased` into the dated section in the same change that updates the SDK version. Never reuse a
published version.
