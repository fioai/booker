import { readFile } from 'node:fs/promises';

import type { PostgresDatabasePort, PostgresTransactionPort } from './postgres-database.js';
import { qualifiedTable, quoteIdentifier } from './sql-identifiers.js';

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
] as const;

async function readMigrations(): Promise<readonly { readonly id: string; readonly sql: string }[]> {
  return Promise.all(
    MIGRATION_FILES.map(async (id) => ({
      id,
      sql: await readFile(new URL(`../migrations/${id}`, import.meta.url), 'utf8'),
    })),
  );
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
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const migration of migrations) {
    const applied = await transaction.query<{ id: string }>(
      `SELECT id FROM ${migrationTable} WHERE id = $1`,
      [migration.id],
    );
    if (applied.rowCount !== 0) {
      continue;
    }

    await transaction.query(`SET LOCAL search_path TO ${schema}, public`);
    await transaction.query(migration.sql);
    await transaction.query(`INSERT INTO ${migrationTable} (id) VALUES ($1)`, [migration.id]);
  }
}

export async function runMigrations(database: PostgresDatabasePort): Promise<void> {
  const migrations = await readMigrations();
  await database.withTransaction((transaction) =>
    applyMigrations(transaction, database, migrations),
  );
}
