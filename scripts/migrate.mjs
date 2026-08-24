/* global process */

import { createPostgresDatabase, runMigrations } from '../packages/database-postgres/dist/index.js';

import { safeEnvironmentSummary, validateMigrationEnvironment } from './lib/environment.mjs';

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/migrate.mjs',
      '',
      'Requires BOOKING_ENGINE_ENV, DATABASE_URL, and optional DATABASE_SCHEMA.',
      'Refuses sample-data bootstrapping and never drops a schema.',
    ].join('\n') + '\n',
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const config = validateMigrationEnvironment(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    schema: config.schema,
  });
  try {
    await runMigrations(database);
  } finally {
    await database.close();
  }
  process.stdout.write('Migrations applied (' + safeEnvironmentSummary(config) + ').\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'migration failed';
  process.stderr.write('Migration failed: ' + message + '\n');
  process.exitCode = 1;
});
