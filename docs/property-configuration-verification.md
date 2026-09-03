> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Property configuration verification

Date: 2026-07-12

## RED-first checkpoint

The pre-existing property suite was green before the review tests were added:

```text
corepack.cmd pnpm test -- packages/booking-core/test/property/configuration.test.ts
```

Result: exit `0`; 2 test files passed and 17 tests passed. This was not sufficient
evidence because the suite did not cover the review requirements.

The focused review suite was then run before implementation fixes:

```text
corepack.cmd pnpm test -- packages/booking-core/test/property/configuration.test.ts
```

Result: expected RED, exit `1`.

Captured result summary:

```text
packages/booking-core/test/property/configuration.test.ts (33 tests | 33 failed)
Test Files: 1 failed, 1 passed (2 total)
Tests: 33 failed, 2 passed (35 total)
Primary failure: createPropertyConfiguration is not a function
Additional missing-contract failures: PROPERTY_CONFIGURATION_LIMITS is undefined
```

The RED suite covers complete ISO data and ASCII-before-folding, Brazil positive
cases, runtime forgery/subclass construction and serialization, sparse and oversized
array non-traversal, bounded strings, own plain records and unknown keys, aliases,
control characters, timezone canonicalization, exact focused errors, expanded bed
capacity, and public/private JSON separation. Mapper and public-contract privacy
assertions now execute at the API composition boundary.

## Public-contract boundary repair

The behavioral suite was green while the architecture was still RED: the SDK
manifest declared `@booking-engine/booking-core`, and
`packages/sdk-typescript/src/property/configuration/mapper.ts` imported that private
domain and was re-exported by the SDK. Admin and storefront therefore had a
transitive path to the private server domain.

The GREEN repair moves `serializePublicProperty` and its runtime/privacy tests to
`apps/api`. The API depends on both `booking-core` and the SDK and is the only package
that exports the mapper. The SDK now contains only explicitly V1-versioned public
types/client contracts, has no dependency fields, no core project reference, and no
workspace imports in its source. Admin and storefront remain SDK-only consumers.

Evidence after the repair:

```text
corepack.cmd pnpm check:public-boundary
Result: exit 0; Public contract boundary check passed (1 SDK source file(s)).

corepack.cmd pnpm test
Result: exit 0; 3 test files passed and 38 tests passed.
```

## Data and runtime prerequisites

- The domain-owned ISO 3166-1 alpha-2 data is the complete 249-code assigned set;
  reserved, user-assigned, and historical elements are excluded. The standard's
  current-code scope is described by [ISO](https://www.iso.org/iso-3166-country-codes.html).
- The domain-owned ISO 4217 data is the 178-code `List One: Current Currency & Funds`
  snapshot published for `2026-01-01` by the [SIX ISO 4217 maintenance agency](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html).
  The snapshot includes `BRL` and the current funds/supranational codes, while
  excluding historical codes such as `BGN` after the 2026 Bulgaria change.
- IANA timezone spelling is canonicalized with `Intl.DateTimeFormat(...).resolvedOptions()`.
  Deterministic output therefore requires the deployment runtime's pinned Node.js
  version and its tzdata/ICU data; equivalent spelling/output is not promised across
  arbitrary runtimes.

## Slice evidence

- The 0.0.0 workspace is unreleased. The bootstrap `displayName` placeholder is
  intentionally replaced by the explicit V1 contract; no compatibility shim is
  required and this is not described as an in-place migration of a released v1.
- Domain types, validation, ISO snapshots, bounded array readers, invariants, and the
  private canonical implementation are owned by `booking-core`. The SDK owns only
  independently named public V1 types/client contracts; the API owns and exports the
  outward mapper. The API composes `booking-core` and the SDK; `booking-core` has no
  SDK dependency. Admin and storefront retain SDK-only dependencies.
- Canonical state is held in a module-private class backed by a private WeakSet and
  WeakMap. The constructor token, frozen prototype/object, opaque type, and mapper
  brand check cover reflective construction, plain-object forgery, and subclass-shaped
  spoofs. Default JSON/stringification of domain state cannot expose operational notes.
- The old monolith is split into focused source modules; the largest behavioral module
  is the 287-line bounded text/record validator, with arrays and cross-field rules in
  separate modules.

## Final verification

The commands below used the pinned Corepack Windows path from the repository root:

| Command                                       | Result                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `corepack.cmd pnpm install --frozen-lockfile` | pass; lockfile is up to date and workspace links installed                  |
| `corepack.cmd pnpm format:check`              | pass; all files matched Prettier                                            |
| `corepack.cmd pnpm lint`                      | pass with `--max-warnings=0`                                                |
| `corepack.cmd pnpm typecheck`                 | pass; project references and tests typechecked                              |
| `corepack.cmd pnpm check:public-boundary`     | pass; one SDK source file audited with no dependencies or workspace imports |
| `corepack.cmd pnpm test`                      | pass; 3 files and 38 tests                                                  |
| `corepack.cmd pnpm test:integration`          | pass with no test files; no integration coverage claimed                    |
| Browser verification (historical)             | No repository E2E script exists; no claim made here.                        |
| `corepack.cmd pnpm build`                     | pass                                                                        |
| `docker compose config`                       | pass; PostgreSQL and Mailpit rendered                                       |
| `git diff --check`                            | pass; Git emitted only LF-to-CRLF conversion warnings                       |

## Remaining risks

- ISO data is a deterministic 2026-01-01 domain snapshot and must be reviewed when
  ISO maintenance agencies publish a later active-code list.
- Timezone canonicalization depends on the pinned Node.js tzdata/ICU runtime.
- Integration, E2E, persistence, API, and UI behavior remain outside this focused
  repair and are not claimed by the passing no-test commands.
