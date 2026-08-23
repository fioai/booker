/* global process */

import { validateRuntimeEnvironment } from './lib/environment.mjs';

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
      const { hashOwnerPasswordV1 } = apiModule;
      const passwordHash = await hashOwnerPasswordV1(config.samplePassword);
      await seedModule.seedSampleData(database, passwordHash);
    }

    const properties = databaseModule.createPostgresPropertyRepository(database);
    const availability = databaseModule.createAvailabilityRepository(database);
    const rates = databaseModule.createRateRepository(database);
    const bookingRequests = databaseModule.createPostgresBookingRequestRepository(database);
    const credentials = apiModule.createPostgresAdminCredentialStoreV1(database);
    const sessions = apiModule.createPostgresAdminSessionStoreV1(database, { maxSessions: 10 });
    server = apiModule.createPublicBookingHttpServerV1(
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
      'Lotus Booking API listening on ' + config.host + ':' + config.port + '.\n',
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
