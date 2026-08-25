> **Archived verification record:** Historical evidence only. Current gates are the root scripts and CI workflow; this dated record is not a release checklist.

# Bootstrap verification record

Date: 2026-07-12

Requested executor: `gpt-5.6-luna xhigh`.

Actually initialized model and effort: unverified; the execution surface did not
expose that runtime metadata.

## Toolchain

- Node.js: `v22.23.1`
- Docker CLI: `29.5.3`
- Corepack-managed pnpm: `10.12.1`
- `pnpm` was initially absent from PATH; Corepack was available, and worker checks
  used its Windows `.cmd` entry point.

## Windows command-path verification

The worker verification used `corepack.cmd pnpm` from PowerShell; that is the
Windows command path documented in the README and used for the checks below.

Sol live verification from Windows Git Bash produced these distinct results:

| Command                                          | Result                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Worker PowerShell: `corepack.cmd pnpm --version` | pass; returned `10.12.1`                                              |
| `corepack pnpm --version`                        | fail; the extensionless shim passed an MSYS-converted `C:\c\...` path |
| `corepack.cmd pnpm --version`                    | pass; returned `10.12.1`                                              |

The extensionless `corepack` command is therefore not claimed to work in this
environment.

## TDD evidence

The only executable behavior in this bootstrap slice is the deterministic test-support
fixed clock. Package boundaries and configuration-only files were not treated as
implemented booking behavior.

### RED

Command:

```text
corepack.cmd pnpm@10.12.1 test -- packages/test-support/test/fixed-clock.test.ts
```

Result: expected failure. Vitest could not load the missing
`../src/fixed-clock.js` implementation; the suite reported one failed file and no
tests collected.

### Minimal GREEN

After adding only `packages/test-support/src/fixed-clock.ts`:

```text
corepack.cmd pnpm@10.12.1 test -- packages/test-support/test/fixed-clock.test.ts
```

Result: exit `0`; one file passed and two tests passed.

## Full verification

All worker commands below were run from the repository root using the pinned
Corepack package manager through `corepack.cmd`.

| Command                                       | Result                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `corepack.cmd pnpm install --frozen-lockfile` | pass, lockfile up to date; final run had no warnings        |
| `corepack.cmd pnpm format:check`              | pass; all files matched Prettier                            |
| `corepack.cmd pnpm lint`                      | pass with `--max-warnings=0`                                |
| `corepack.cmd pnpm typecheck`                 | pass; project references and tests typechecked              |
| `corepack.cmd pnpm test`                      | pass; 1 file and 2 tests                                    |
| `corepack.cmd pnpm build`                     | pass                                                        |
| `corepack.cmd pnpm test:integration`          | pass with no test files; no integration coverage is claimed |
| Browser verification (historical)             | No repository E2E script exists; no claim made here.        |
| `docker compose config`                       | pass; PostgreSQL and Mailpit services rendered              |

No `docker compose up` command was run. A later `docker compose ps -a` audit could not
connect because Docker Desktop's Linux engine was not running, so no container-state
claim is made beyond the fact that this bootstrap did not start containers.

## Scope audit

- No booking domain, authentication, payment, iCalendar, deployment, or broad UI
  behavior was implemented.
- No property-specific terms were found under `apps/` or `packages/`.
- `.env.example` contains placeholders only.
- No Git remote, commit, push, publish, or deploy operation was performed.
