# Backup and restore

Backups contain tenant identities, guest PII, booking messages, quotes, inventory,
outbox payloads, iCalendar provenance, and payment event metadata. Treat them as
production data: encrypt at rest and in transit, restrict access, define retention,
and record restore access. Never commit a dump or put a connection string in a log.

## Rehearsal command

The repository verifier requires a local/test environment and a source database
containing migrated property/rate data:

    corepack.cmd pnpm backup:restore

When pg_dump and pg_restore are installed, set BACKUP_USE_HOST_TOOLS=true.
Otherwise the script runs the PostgreSQL tools inside the selected Compose service:

    BACKUP_POSTGRES_SERVICE=postgres
    COMPOSE_PROJECT_NAME=lotus-booking-hardening
    corepack.cmd pnpm backup:restore

The script:

1. Connects to the source database without printing DATABASE_URL.
2. Creates a fresh database with a hard-coded lotus*restore* prefix.
3. Runs a custom-format pg_dump from the source.
4. Streams that archive to pg_restore in the separate empty database.
5. Compares row counts across all Lotus tables and verifies the availability
   exclusion constraint, no active overlap, and foreign-key-backed request
   references.
6. Removes only the temporary database and temporary archive.

The clean-room command performs this exercise after its real public/admin smoke:

    corepack.cmd pnpm docker:clean-room

The target database is deliberately separate from the source. A successful restore
is not a substitute for an application-level privacy check or a disaster-recovery
rehearsal with encrypted off-host backups.

## Windows PowerShell and Git Bash

PowerShell:

    $env:LOTUS_ENV='local'
    $env:DATABASE_URL='postgresql://lotus_booking_local:local-only-placeholder@127.0.0.1:15432/lotus_booking_local'
    $env:DATABASE_SCHEMA='public'
    $env:COMPOSE_PROJECT_NAME='lotus-booking-hardening'
    corepack.cmd pnpm backup:restore

Git Bash:

    export LOTUS_ENV=local
    export DATABASE_URL='postgresql://lotus_booking_local:local-only-placeholder@127.0.0.1:15432/lotus_booking_local'
    export DATABASE_SCHEMA=public
    export COMPOSE_PROJECT_NAME=lotus-booking-hardening
    corepack.cmd pnpm backup:restore

Use corepack.cmd in Git Bash so MSYS does not rewrite a path passed to the
extensionless Corepack shim. Quote a URL when it contains shell metacharacters and
URL-encode reserved characters in a real password. Do not use docker compose exec
without -T; an allocated TTY can corrupt a custom-format archive.

## Recovery procedure

For a real incident, stop writes or route traffic away, identify the backup timestamp,
restore into a separately named database, run schema/migration and invariant checks,
then run the public-boundary and admin smoke against the restored copy. Obtain owner
approval before switching the application connection. Preserve the original source
database until the recovery is accepted. Never run DROP DATABASE, DROP SCHEMA, or
bulk deletion against a production target from these local verification scripts.
