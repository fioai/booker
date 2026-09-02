/* global process */

import { validateRuntimeEnvironment } from './lib/environment.mjs';
import { loadEnvironment } from './lib/load-environment.mjs';

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/run-api.mjs',
      '',
      'Runs migrations, optionally seeds explicitly enabled local sample data, and starts the',
      'public and same-origin admin HTTP boundaries.',
    ].join('\n') + '\n',
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  loadEnvironment();
  const config = validateRuntimeEnvironment(process.env);
  const [databaseModule, apiModule, seedModule] = await Promise.all([
    import('../packages/database-postgres/dist/index.js'),
    import('../apps/api/dist/index.js'),
    import('./seed-sample.mjs'),
  ]);
  const database = databaseModule.createPostgresDatabase({
    connectionString: config.databaseUrl,
    schema: config.schema,
  });
  let server;
  try {
    await databaseModule.runMigrations(database);
    if (config.sampleData) {
      const { hashOwnerPassword } = apiModule;
      const passwordHash = await hashOwnerPassword(config.samplePassword);
      await seedModule.seedSampleData(database, passwordHash);
    }

    const properties = databaseModule.createPostgresPropertyRepository(database);
    const availability = databaseModule.createPostgresAvailabilityRepository(database);
    const rates = databaseModule.createPostgresRateRepository(database);
    const bookingRequests = databaseModule.createPostgresBookingRequestRepository(database);
    const credentials = apiModule.createPostgresAdminCredentialStore(database);
    const sessions = apiModule.createPostgresAdminSessionStore(database, { maxSessions: 10 });
    server = apiModule.createApiHttpServer(
      {
        properties,
        availability,
        rates,
        bookingRequests,
      },
      {
        scope: { organizationId: config.organizationId },
        admin: {
          dependencies: {
            credentials,
            properties,
            rates,
            availability,
            bookingRequests,
            ical: {
              health: (_scope, sourceId) => ({
                sourceId,
                lastAttemptAt: null,
                lastSuccessAt: null,
                stale: true,
                error: null,
              }),
            },
          },
          options: {
            secureCookies: config.secureCookies,
            sessionStore: sessions,
            ...(config.adminOrigin === undefined ? {} : { origin: config.adminOrigin }),
          },
        },
      },
    );
    await server.listen(config.port, config.host);
    process.stdout.write(
      'Booking Engine API listening on ' + config.host + ':' + config.port + '.\n',
    );
  } catch (error) {
    await database.close();
    throw error;
  }

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
    await database.close();
  };
  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
}

main().catch(() => {
  process.stderr.write(
    'API startup failed: check environment, PostgreSQL connectivity, and migration output.\n',
  );
  process.exitCode = 1;
});
