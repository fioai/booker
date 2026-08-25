import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { PostgresDatabasePort, PostgresTransactionPort } from './postgres.js';
import { qualifiedTable, quoteIdentifier } from './identifiers.js';

const MIGRATION_FILES = [
  '001_organizations_properties.sql',
  '002_availability_rates.sql',
  '003_booking_requests.sql',
  '004_ical_blocks.sql',
  '005_request_lifecycle.sql',
  '006_owner_auth.sql',
  '007_admin_sessions.sql',
  '008_payments.sql',
  '009_public_pending_requests.sql',
  '010_request_lifecycle_legacy_repair.sql',
] as const;

async function readMigrations(): Promise<readonly { readonly id: string; readonly sql: string }[]> {
  return Promise.all(
    MIGRATION_FILES.map(async (id) => ({
      id,
      sql: await readFile(new URL(`../../migrations/${id}`, import.meta.url), 'utf8'),
    })),
  );
}

export class MigrationDriftError extends Error {
  readonly migrationId: string;
  readonly storedChecksum: string;
  readonly currentChecksum: string;

  constructor(migrationId: string, storedChecksum: string, currentChecksum: string) {
    super(`Migration checksum drift detected for ${migrationId}.`);
    this.name = 'MigrationDriftError';
    this.migrationId = migrationId;
    this.storedChecksum = storedChecksum;
    this.currentChecksum = currentChecksum;
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function applyMigrations(
  transaction: PostgresTransactionPort,
  database: PostgresDatabasePort,
  migrations: readonly { readonly id: string; readonly sql: string }[],
): Promise<void> {
  const migrationTable = qualifiedTable(database, 'schema_migrations');
  const schema = quoteIdentifier(database.schema);

  // A transaction-scoped advisory lock serializes schema creation, migration execution,
  // and marker insertion across every process using this database schema.
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `booking-engine:migrations:${database.schema}`,
  ]);
  await transaction.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await transaction.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      checksum TEXT
    )
  `);
  await transaction.query(`ALTER TABLE ${migrationTable} ADD COLUMN IF NOT EXISTS checksum TEXT`);

  for (const migration of migrations) {
    const currentChecksum = checksum(migration.sql);
    const applied = await transaction.query<{ id: string; checksum: string | null }>(
      `SELECT id, checksum FROM ${migrationTable} WHERE id = $1`,
      [migration.id],
    );
    const appliedRow = applied.rows[0];
    if (appliedRow !== undefined) {
      if (appliedRow.checksum === null) {
        await transaction.query(`UPDATE ${migrationTable} SET checksum = $2 WHERE id = $1`, [
          migration.id,
          currentChecksum,
        ]);
      } else if (appliedRow.checksum !== currentChecksum) {
        throw new MigrationDriftError(migration.id, appliedRow.checksum, currentChecksum);
      }
      continue;
    }

    await transaction.query(`SET LOCAL search_path TO ${schema}, public`);
    await transaction.query(migration.sql);
    await transaction.query(`INSERT INTO ${migrationTable} (id, checksum) VALUES ($1, $2)`, [
      migration.id,
      currentChecksum,
    ]);
  }
}

export async function runMigrations(database: PostgresDatabasePort): Promise<void> {
  const migrations = await readMigrations();
  await database.withTransaction((transaction) =>
    applyMigrations(transaction, database, migrations),
  );
}
