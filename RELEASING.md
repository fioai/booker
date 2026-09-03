# Releasing

Booking Engine is pre-release. The runtime is not recommended for production traffic. This
document describes the release procedure for the public
`@booking-engine/sdk-typescript` package and any matching runtime release.

## Current release status

The `v0.1.0` tag is the first public SDK release target. The release is complete only when the
annotated tag points to the approved commit and the publication workflow has published
`@booking-engine/sdk-typescript@0.1.0` with npm provenance.

Do not describe the runtime as production-ready. A tag alone is not a package publication, and a
registry entry without the matching tag is not a complete release.

## Version and tag rules

- Use [Semantic Versioning](https://semver.org/) for the SDK package version in
  `packages/sdk-typescript/package.json`.
- Keep the private workspace package at its existing private version. Only the SDK package has a
  public release version in this release line.
- While the SDK is below `1.0.0`, use a patch increment for compatible fixes and a minor increment
  for additive, backward-compatible V1 features. Do not make an unannounced breaking V1 change.
  Record a breaking change and migration plan before choosing a new major public version.
- Create one annotated tag per SDK version, named exactly `v<version>` (for example, `v0.1.0`).
  The tag must point to the commit that contains the package version and matching changelog entry.
- Never reuse a published version or tag. Publish a new patch version for a correction.
- Update [`CHANGELOG.md`](CHANGELOG.md) in the same release change. A release entry must state the
  version, date, user-visible changes, and any migration or deprecation guidance.

## Release gates

Run these commands from the repository root on the exact candidate commit. Use a complete process
environment for deployment checks; do not mix local `.env` values with deployment identity values.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm backup:restore -- --confirm-database <database-name>
corepack pnpm build
corepack pnpm check:architecture
corepack pnpm check:public-boundary
corepack pnpm check:public-contract
corepack pnpm check:sdk-package
corepack pnpm check:env
corepack pnpm scan:secrets
corepack pnpm scan:history
corepack pnpm audit:dependencies
git diff --check main...HEAD
git diff --cached --check
git diff --check
docker compose config --quiet
corepack pnpm docker:clean-room
```

Replace `<database-name>` with the database name decoded from the effective `DATABASE_URL`. The
confirmation must match exactly. A running Docker Engine is required for the Docker-backed gates;
mocked evidence does not replace them.

`corepack pnpm scan:history` is a release blocker. Run it with the complete repository history. If
it reports a credential, stop the release, revoke or rotate the credential, and follow the private
security process in [`SECURITY.md`](SECURITY.md). Do not treat a worktree-only scan as history
coverage.

The release candidate is ready for publication only when every gate passes and the required
verification evidence is retained outside the repository without secrets or personal data.

## SDK pack, tag, publish, and provenance

Publication is performed only by [`.github/workflows/publish.yml`](.github/workflows/publish.yml).
The workflow runs on a GitHub-hosted runner with Node.js `22.23.1`, pnpm `10.12.1`, and npm
`11.5.1`. It grants only `contents: read` and `id-token: write`; the ID token lets npm use
GitHub Actions OIDC for trusted publishing and provenance. Do not publish a provenance package
from a workstation.

1. Set the SDK version and create the dated changelog entry in the release commit. For the
   current release, set `SDK_VERSION=0.1.0`:

   ```sh
   export SDK_VERSION=0.1.0
   test "$(node -p "require('./packages/sdk-typescript/package.json').version")" = "$SDK_VERSION"
   ```

2. Run the release gates from the repository root on the exact release commit. Build the SDK and
   run `check:sdk-package`, `check:public-boundary`, `check:public-contract`, `scan:secrets`, and
   `scan:history`. Pack the SDK into a temporary directory and inspect the archive. It must
   contain the built SDK files, `README.md`, and `LICENSE`, and must not contain source maps,
   local environment files, credentials, or workspace packages:

   ```sh
   export RELEASE_TMP="$(mktemp -d)"
   corepack pnpm --dir packages/sdk-typescript pack --pack-destination "$RELEASE_TMP"
   tar -tzf "$RELEASE_TMP"/*.tgz
   ```

3. Run a review-only package dry run from the exact archive. This is not a publication and must
   not use a provenance flag:

   ```sh
   RELEASE_TARBALL="$(printf '%s\n' "$RELEASE_TMP"/*.tgz)"
   npm publish "$RELEASE_TARBALL" --dry-run --access public
   ```

4. Merge the approved release commit to `main`. The workflow compares the tagged commit with
   the current `origin/main`, so create and push the annotated tag only after the merge and all
   gates pass:

   ```sh
   git tag --annotate "v${SDK_VERSION}" --message "Booking Engine SDK ${SDK_VERSION}"
   git push origin "v${SDK_VERSION}"
   ```

5. Bootstrap the first package publication with one npm token. Before pushing `v0.1.0`, add a
   repository Actions secret named exactly `NPM_TOKEN`. Give it only the npm publish permission
   required for this package. The workflow reads only `secrets.NPM_TOKEN`, maps it to
   `NODE_AUTH_TOKEN` for the publish step, and never writes the token to a file, command
   argument, or log. Do not add another secret for this workflow.

6. Pushing the tag starts this workflow. It verifies the tag and current `origin/main`,
   installs frozen dependencies, runs the SDK build, package, boundary, contract, and secret
   gates, packs and verifies the expected SDK tarball, rejects an already-published version, and
   publishes the public package with the `latest` dist-tag and `--provenance`. Wait for this run
   to pass before announcing the release.

7. After the first publication succeeds, configure the package's [npm Trusted
   Publisher](https://docs.npmjs.com/trusted-publishers):

   - provider: GitHub Actions;
   - organization or user: `fioai`;
   - repository: `booker`;
   - workflow filename: `publish.yml`.

   npm asks for the filename only. The workflow path in this repository is exactly
   `.github/workflows/publish.yml`. Select the `npm publish` allowed action and do not add an
   environment name that is not configured in the workflow.

8. Remove the `NPM_TOKEN` repository secret after the trusted publisher is verified. Do not
   replace it with another token. Future `v<version>` tags use the same workflow with
   OIDC-only release authentication: npm `11.5.1` obtains short-lived credentials through
   GitHub Actions OIDC and creates the provenance attestation. The workflow keeps
   `--provenance` explicit for this contract.

9. Verify the registry result before announcing the release:

   ```sh
   npm view "@booking-engine/sdk-typescript@${SDK_VERSION}" version dist.integrity dist.tarball
   npm audit signatures
   ```

   The reported version, tarball, and integrity must match the reviewed package. Confirm the
   registry provenance or attestation record as well. Keep the tag and release evidence.

## Rollback and deprecation

- For a runtime problem, stop or drain write traffic as required by the deployment procedure and
  redeploy the last accepted runtime commit. Use the previous image only when its schema is
  compatible with the current database. Never run an old image against incompatible migrations;
  prefer a forward fix or an approved database recovery procedure.
- A published npm version cannot be replaced safely. Do not overwrite or silently republish it.
  Deprecate a bad version with a clear replacement message, then publish a corrected version:

  ```sh
  npm deprecate @booking-engine/sdk-typescript@<bad-version> "Use <replacement-version>; see the release notes."
  ```

- Keep the original tag and release evidence. Record the deprecation and replacement in
  [`CHANGELOG.md`](CHANGELOG.md), and communicate the action through the normal issue route.
- For a vulnerability, do not use a public issue. Use the [GitHub Security Advisory route](https://github.com/fioai/booker/security/advisories/new), rotate affected credentials, and coordinate any deprecation or runtime rollback privately.
