# Changelog

All notable user-visible changes are recorded here. The public SDK follows the version and tag
rules in [`RELEASING.md`](RELEASING.md).

## Unreleased

- The Booking Engine runtime remains pre-release and is not recommended for production traffic.
- `@booking-engine/sdk-typescript` `0.1.0` remains an unpublished release candidate. It has no
  release tag or registry publication yet.
- Release documentation now defines support, security reporting, release gates, SDK provenance,
  rollback, and deprecation procedures.
- Runtime images contain compiled application files and production dependencies; development
  tooling, source, tests, and the unused Mailpit service have been removed from deployment.
- Dependency audits now include development tooling and reject moderate or higher advisories.
  Vitest and affected transitive dependencies have been updated.
- Secret scanning checks index contents for unstaged deletions and documents exact historical
  sample exceptions. Verification guidance replaces archived development transcripts.
- A local Juniper Cabin website now demonstrates quotes, booking requests and an authenticated
  owner inbox against the real API. The README includes screenshots and an integration tutorial;
  the demo displays the public property descriptions and sleeping arrangements, uses a CC0 cabin
  photograph, adds no frontend dependencies and is separate from the runtime image.
- Reviewed demo images are admitted by exact path and SHA-256 in the worktree, index and
  history scans. The bounded read limit is 4 MiB; unreviewed binaries still fail.

## Release entry rules

Each published SDK version gets a dated section named `X.Y.Z`. Record added, changed, fixed,
security, and deprecated behavior, plus migration instructions when relevant. Move entries from
`Unreleased` into the dated section in the same change that updates the SDK version. Never reuse a
published version.
