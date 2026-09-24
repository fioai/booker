# Releasing

Booking Engine is pre-release. The runtime is not recommended for production traffic, and the
public SDK is not published yet. This document is the release procedure for
`@fiolabs/booking-engine` and for a matching runtime release.

## Current release status

`@fiolabs/booking-engine` version `0.1.0` is an **unpublished release candidate**. It is
not a registry release until both of these conditions are true:

1. the annotated `v0.1.0` Git tag points to the approved release commit; and
2. the package registry shows `@fiolabs/booking-engine@0.1.0` with provenance.

Do not describe the candidate as published or recommend the runtime for production traffic.

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

## npm account and GitHub setup

The public package name is `@fiolabs/booking-engine`. The publisher must own the `fiolabs` npm
account or have permission to create and publish packages in the `fiolabs` organization.
Enable two-factor authentication on the npm account.

Publication runs on GitHub-hosted runners in
[`publish.yml`](.github/workflows/publish.yml). Merge the workflow to `main` before using it in
GitHub Actions. It is started manually and defaults to `dry-run`; pushing a tag alone does not
publish anything. Every mode runs the reusable CI workflow, including PostgreSQL integration and
the Docker clean-room smoke and backup/restore checks, before packing the SDK.

### First release

npm requires a package to exist before it can have a trusted publisher. For the first release:

1. Create a short-lived granular npm access token with read/write package permissions for the
   `fiolabs` scope, permission to create this package, and **Bypass 2FA** enabled for the
   non-interactive publish. Organization management permissions are not needed.
2. In `fioai/booker`, open **Settings → Secrets and variables → Actions** and save the token as
   the repository secret `NPM_BOOTSTRAP_TOKEN`. Enter it directly in GitHub's secret field;
   never put its value in a repository file, command argument, issue, or log.
3. Follow the pack/tag procedure below, then run the workflow on `v0.1.0` with mode `bootstrap`.
   Only this mode receives the bootstrap secret, and only during the publication step.
   The package is built and published with provenance on GitHub.
4. Once the registry verification succeeds, configure the trusted publisher below, remove the
   GitHub bootstrap secret, and revoke the bootstrap token on npm.

See npm's [trusted publisher prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
and [publishing authentication requirements](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

### Later releases with trusted publishing

In the npm package's **Settings → Trusted publishing**, add GitHub Actions with these values:

| Field                | Value                       |
| -------------------- | --------------------------- |
| Organization or user | `fioai`                     |
| Repository           | `booker`                    |
| Workflow filename    | `publish.yml`               |
| Environment name     | Leave empty                 |
| Allowed actions      | Permit direct `npm publish` |

The GitHub owner is `fioai`; the npm scope is `fiolabs`. These identify different accounts.
Run subsequent releases with mode `publish`. The workflow uses npm `11.17.0` and grants
`id-token: write` to the publishing job, so npm can authenticate the workflow without an npm
token. It publishes the public archive with provenance. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

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

Reviewed historical sample exceptions are listed in the
[secret-scanning policy](docs/security/secret-scanning.md); they do not exempt changed content.
The dependency audit covers the complete workspace, including development tools, and rejects
moderate or higher advisories.

The release candidate is ready for publication only when every gate passes and the required
verification evidence is retained outside the repository without secrets or personal data.

## SDK pack, tag, publish, and provenance

1. Set the SDK version and create a dated changelog entry that labels it an unpublished release
   candidate. For the current candidate, set `SDK_VERSION=0.1.0`. Confirm the SDK README has the
   same status until the tag and registry publication succeed.

   ```sh
   export SDK_VERSION=0.1.0
   test "$(node -p "require('./packages/sdk-typescript/package.json').version")" = "$SDK_VERSION"
   ```

2. Build and run `check:sdk-package` from the root. Confirm that the package has no workspace
   dependencies and that its packed files contain only the intended public surface.
3. Pack into a temporary directory, not the repository:

   ```sh
   export RELEASE_TMP="$(mktemp -d)"
   corepack pnpm --dir packages/sdk-typescript pack --pack-destination "$RELEASE_TMP"
   tar -tzf "$RELEASE_TMP"/*.tgz
   ```

   Inspect the archive. It must contain the built SDK files, `README.md`, and `LICENSE`, and must
   not contain source maps that point outside the archive, local environment files, credentials, or
   workspace packages.

4. Run a package publish dry run from the exact candidate archive and review the final package
   name, version, access setting, and files:

   ```sh
   RELEASE_TARBALL="$(printf '%s\n' "$RELEASE_TMP"/*.tgz)"
   npm publish "$RELEASE_TARBALL" --dry-run --access public
   ```

   To exercise the complete GitHub workflow without publishing, select **Actions → Publish npm
   package → Run workflow**, choose the candidate branch, and leave the mode as `dry-run`.
   The run retains the packed `.tgz` as an artifact for 30 days. This mode needs no npm
   credentials and does not verify publishing permissions.

5. Merge the approved release commit to the protected release branch. Create and push the
   annotated tag only after all gates and the dry run pass:

   ```sh
   git tag --annotate "v${SDK_VERSION}" --message "Booking Engine SDK ${SDK_VERSION}"
   git push origin "v${SDK_VERSION}"
   ```

6. Start **Publish npm package** from the exact `v<version>` tag. Use `bootstrap` for the first
   release, or `publish` after trusted publishing has been configured. The GitHub CLI equivalent
   for a later release is:

   ```sh
   gh workflow run publish.yml --repo fioai/booker --ref "v${SDK_VERSION}" -f mode=publish
   ```

   Replace `mode=publish` with `mode=bootstrap` for the first release. The workflow requires an
   annotated tag, a matching package version and changelog entry, and a tagged commit contained
   in `main`. It re-runs all CI gates on that commit, builds the package, checks installation in
   a separate consumer project, and publishes the same archive retained in the workflow run.
   Provenance publication runs on GitHub; a local `npm login` alone cannot produce it.

7. Verify the registry result before announcing the release:

   ```sh
   npm view "@fiolabs/booking-engine@${SDK_VERSION}" version dist.integrity dist.tarball dist.attestations
   ```

   The workflow verifies the reported version and SHA-512 integrity against the retained archive
   and requires a registry provenance record. A tag alone is not a publication, and a registry
   entry without the matching tag is not a complete release. If publication succeeds but the
   registry verification fails, inspect that version and its attestations before taking further
   action; do not delete or recreate the release tag or attempt to overwrite the version.

8. Update the changelog and SDK README from “unpublished release candidate” to the dated release
   status in a follow-up documentation change only after the tag and registry checks succeed.

## Rollback and deprecation

- For a runtime problem, stop or drain write traffic as required by the deployment procedure and
  redeploy the last accepted runtime commit. Use the previous image only when its schema is
  compatible with the current database. Never run an old image against incompatible migrations;
  prefer a forward fix or an approved database recovery procedure.
- A published npm version cannot be replaced safely. Do not overwrite or silently republish it.
  Deprecate a bad version with a clear replacement message, then publish a corrected version:

  ```sh
  npm deprecate @fiolabs/booking-engine@<bad-version> "Use <replacement-version>; see the release notes."
  ```

- Keep the original tag and release evidence. Record the deprecation and replacement in
  [`CHANGELOG.md`](CHANGELOG.md), and communicate the action through the normal issue route.
- For a vulnerability, do not use a public issue. Use the [GitHub Security Advisory route](https://github.com/fioai/booker/security/advisories/new), rotate affected credentials, and coordinate any deprecation or runtime rollback privately.
