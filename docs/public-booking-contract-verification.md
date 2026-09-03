> **Archived verification record:** Historical evidence only. Use the single authoritative
> [README release checklist](../README.md#development-and-release-gates). The CI workflow and root
> scripts implement its checks; they do not define a second command list. This dated record is not
> a release checklist.

# Public booking contract verification

Date: 2026-07-12

## Scope

This record covers the versioned V1 public property, availability, quote, and
request-to-book REST/OpenAPI contract, a dependency-free typed TypeScript SDK client,
bounded contract validation, stable public errors, tenant-scoped API composition, and a
PostgreSQL-backed pending request-to-book repository.

The request response is deliberately an acknowledgement with `pending` status. Guest
contact fields, tenant identifiers, and private operational notes are persisted only in
server-side shapes and are excluded by explicit public serializers and SDK response
guards. The SDK remains flat, dependency-free, and free of storefront-specific imports.

## RED checkpoint

The focused tests were created before the implementation modules and run after the pinned
workspace install. The install itself was a prerequisite, not the RED checkpoint:

```text
corepack.cmd pnpm install --frozen-lockfile
```

Result: exit `0`; pnpm `10.12.1`, 13 workspace projects, lockfile unchanged.

SDK contract RED:

```text
corepack.cmd pnpm exec vitest run packages/sdk-typescript/test/public-contract.test.ts --reporter=verbose
```

Result: exit `1`; 1 test file failed, 2 tests failed. The genuine missing-implementation
failures were `Cannot read properties of undefined (reading 'openapi')` and
`createBookingEngineClientV1 is not a function`.

API contract RED:

```text
corepack.cmd pnpm exec vitest run apps/api/test/public/booking/api.test.ts --reporter=verbose
```

Result: exit `1`; 1 test file failed, 4 tests failed. The failures were missing
`createPublicBookingApi`, `createPublicBookingHttpApi`, and
`serializePublicQuote` exports.

PostgreSQL contract RED:

```text
corepack.cmd pnpm exec vitest run tests/integration/public-api-contract.test.ts --reporter=verbose
```

Result: exit `1`; the PostgreSQL setup reached the tests, but both tests failed because
`createPostgresBookingRequestRepository` was not a function.

## GREEN checkpoint

Focused SDK and API GREEN:

```text
corepack.cmd pnpm exec vitest run packages/sdk-typescript/test/public-contract.test.ts apps/api/test/public/booking/api.test.ts --reporter=verbose
```

Result: exit `0`; 2 test files passed, 11 tests passed.

Focused PostgreSQL contract GREEN:

```text
corepack.cmd pnpm exec vitest run tests/integration/public-api-contract.test.ts --reporter=verbose
```

Result: exit `0`; 1 PostgreSQL-backed test file passed, 2 tests passed.

## Focused repair-pass RED/GREEN

The SDK response-guard regression was added before the production guard repair:

```text
corepack.cmd pnpm exec vitest run packages/sdk-typescript/test/public-contract.test.ts --reporter=verbose
```

RED result: exit `1`; the new test failed because an out-of-contract `propertyType` value
was accepted by the public-property response guard. GREEN result after the guard repair: exit
`0`; 1 test file passed, 6 tests passed.

## Final verification

| Command                                                              | Result                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `corepack.cmd pnpm format:check`                                     | exit `0`; all files matched Prettier                          |
| `corepack.cmd pnpm lint`                                             | exit `0`; ESLint passed with `--max-warnings=0`               |
| `corepack.cmd pnpm typecheck`                                        | exit `0`; project references and strict test typecheck passed |
| `corepack.cmd pnpm test`                                             | exit `0`; 5 package test files, 52 tests passed               |
| `corepack.cmd pnpm exec vitest run packages apps/api --reporter=dot` | exit `0`; 7 unit test files, 62 tests passed                  |
| `corepack.cmd pnpm test:integration`                                 | exit `0`; 3 PostgreSQL integration files, 14 tests passed     |
| `corepack.cmd pnpm check:public-boundary`                            | exit `0`; 4 SDK source files audited, no workspace imports    |
| `corepack.cmd pnpm build`                                            | exit `0`; strict composite build passed                       |
| `docker compose config`                                              | exit `0`; local PostgreSQL/Mailpit config rendered            |
| `git diff --check`                                                   | exit `0`; only expected LF-to-CRLF conversion warnings        |
