# Changelog

All notable user-visible changes are recorded here. The public SDK follows the version and tag
rules in [`RELEASING.md`](RELEASING.md).

## Unreleased

- The Booking Engine runtime remains pre-release and is not recommended for production traffic.
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

## 0.1.0 - 2026-09-12 (unpublished release candidate)

- Prepare the first public TypeScript SDK release as `@fiolabs/booking-engine`.
  This candidate has no release tag or registry publication yet.
- Include the V1 client for public property details, availability, quotes, and idempotent
  request-to-book submissions, with strict response validation and no runtime dependencies.
- Add a manually started npm release workflow with a dry run, first-release authentication,
  trusted publishing, required CI gates, and archive/provenance verification.
- Upgrade the development test runner to Vitest `4.1.11` to address
  [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) and pass the dependency
  release gate.
- For existing workspace or tarball consumers, replace imports of the former SDK package name
  with `@fiolabs/booking-engine`. The client API and HTTP contract are unchanged.

## Release entry rules

Each published SDK version gets a dated section named `X.Y.Z`. Record added, changed, fixed,
security, and deprecated behavior, plus migration instructions when relevant. Move entries from
`Unreleased` into the dated section in the same change that updates the SDK version. Never reuse a
published version.
