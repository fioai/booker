# Changelog

All notable user-visible changes are recorded here. The public SDK follows the version and tag
rules in [`RELEASING.md`](RELEASING.md).

## Unreleased

- The Booking Engine runtime remains pre-release and is not recommended for production traffic.
- `@booking-engine/sdk-typescript` `0.1.0` remains an unpublished release candidate. It has no
  release tag or registry publication yet.
- Release documentation now defines support, security reporting, release gates, SDK provenance,
  rollback, and deprecation procedures.

## Release entry rules

Each published SDK version gets a dated section named `X.Y.Z`. Record added, changed, fixed,
security, and deprecated behavior, plus migration instructions when relevant. Move entries from
`Unreleased` into the dated section in the same change that updates the SDK version. Never reuse a
published version.
