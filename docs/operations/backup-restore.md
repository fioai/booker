# Backup and restore

Backups contain tenant identities, guest PII, booking messages, quotes, inventory,
outbox payloads, iCalendar provenance, and payment event metadata. Treat them as
production data: encrypt at rest and in transit, restrict access, define retention,
and record restore access. Never commit a dump or put a connection string in a log.

## Rehearsal command

Complete the root Quickstart first. Copy `.env.example` to `.env`, install the
dependencies, and start Compose. The copied environment selects the local source
database and keeps the `DATABASE_URL` credentials aligned with PostgreSQL.

The package command selects one deployment identity source. It loads the complete optional
root `.env` file only when no deployment identity variable is exported. If any deployment
identity variable is exported, it ignores `.env` and uses only the process environment.

Copy the decoded database name from `DATABASE_URL`. Do not copy the URL, user, or password.
For the copied template, the database name is `replace_me_local_database`.

Linux, macOS, or a POSIX shell such as Windows Git Bash:

```sh
corepack pnpm backup:restore -- --confirm-database replace_me_local_database
```

Windows PowerShell or Command Prompt:

```text
corepack.cmd pnpm backup:restore -- --confirm-database replace_me_local_database
```

On Windows Git Bash, use `corepack.cmd pnpm` if the extensionless `corepack` shim fails.
Make the same substitution for the clean-room command below.

When `pg_dump` and `pg_restore` are installed, set `BACKUP_USE_HOST_TOOLS=true` in
the copied `.env` file or export it before the command. Otherwise, the script runs
the PostgreSQL tools in the `postgres` Compose service. `BACKUP_POSTGRES_SERVICE`
selects only the Compose service container that runs these tools. It never authorizes
another connection location. The `DATABASE_URL` host must be one of these literal
loopback values: `127.0.0.1`, `localhost`, or `::1`.

The script:

1. Validates the local or test environment, the literal loopback `DATABASE_URL` host,
   and the exact decoded database-name confirmation before it opens a database pool.
2. Connects to the source database without printing `DATABASE_URL`.
3. Creates a fresh database with a hard-coded `booking_engine_restore_` prefix.
4. Runs a custom-format `pg_dump` from the source.
5. Streams that archive to `pg_restore` in the separate empty database.
6. Compares row counts across all Booking Engine tables and verifies the availability
   exclusion constraint, no active overlap, and foreign-key-backed request
   references.
7. Removes only the temporary database and temporary archive.

The clean-room command performs this exercise after its real public/admin smoke:

    corepack pnpm docker:clean-room

The target database is deliberately separate from the source. A successful restore
is not a substitute for an application-level privacy check or a disaster-recovery
rehearsal with encrypted off-host backups.

## Staging and production safety

Run this verifier only against a dedicated local or test database. The command rejects staging
and production environments. It also rejects a `DATABASE_URL` host that is not the literal
loopback value `127.0.0.1`, `localhost`, or `::1` before it opens a database pool.
`BACKUP_POSTGRES_SERVICE` does not change this rule. It only selects the Compose tool container.
The script creates and drops a temporary database on the local PostgreSQL server in `DATABASE_URL`.

For staging or production recovery, use the approved recovery process and restore
into a separate target. Require owner approval before any connection switch. Never
use the local verification command as a production recovery shortcut.

## Recovery procedure

For a real incident, stop writes or route traffic away, identify the backup timestamp,
restore into a separately named database, run schema/migration and invariant checks,
then run the public-boundary and admin smoke against the restored copy. Obtain owner
approval before switching the application connection. Preserve the original source
database until the recovery is accepted. Never run DROP DATABASE, DROP SCHEMA, or
bulk deletion against a production target from these local verification scripts.
