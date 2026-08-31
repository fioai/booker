/* global clearTimeout, process, setTimeout, URL */

import { Client } from 'pg';

import { validateEnvironment } from './lib/environment.mjs';
import { loadEnvironment } from './lib/load-environment.mjs';

const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = CONNECTION_TIMEOUT_MS + QUERY_TIMEOUT_MS + CLEANUP_TIMEOUT_MS;
const DATABASE_URL_TIMEOUT_PARAMETERS = new Set(
  [
    'connect_timeout',
    'connection_timeout',
    'connectionTimeoutMillis',
    'statement_timeout',
    'statementTimeout',
    'query_timeout',
    'queryTimeout',
  ].map((parameter) => parameter.toLowerCase()),
);

function destroyClientStream(client) {
  const stream = client.connection?.stream;
  if (stream !== undefined && typeof stream.destroy === 'function') {
    try {
      stream.destroy();
    } catch {
      // The fixed failure keeps the probe bounded without exposing connection details.
    }
  }
}

async function probeDatabaseWithinDeadline(client) {
  let deadline;
  let rejectClientError;
  let probeFinished = false;
  const clientError = new Promise((_, reject) => {
    rejectClientError = reject;
  });
  const onClientError = () => {
    destroyClientStream(client);
    rejectClientError(new Error('Database client emitted an error.'));
  };
  client.on('error', onClientError);

  const deadlineExceeded = new Promise((_, reject) => {
    deadline = setTimeout(() => {
      destroyClientStream(client);
      reject(new Error('Database probe exceeded its deadline.'));
    }, PROBE_TIMEOUT_MS);
  });
  const probe = (async () => {
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      try {
        await client.end();
      } finally {
        probeFinished = true;
      }
    }
  })();
  const probeSettled = probe.then(
    () => undefined,
    () => undefined,
  );

  try {
    await Promise.race([probe, clientError, deadlineExceeded]);
  } finally {
    if (!probeFinished) {
      try {
        await Promise.race([probeSettled, deadlineExceeded]);
      } catch {
        // The deadline force-closes the stream, so cleanup remains bounded.
      }
    }
    clearTimeout(deadline);
    client.removeListener('error', onClientError);
  }
}

async function main() {
  loadEnvironment();
  const config = validateEnvironment(process.env, { requireApplicationScope: false });
  const databaseUrl = new URL(config.databaseUrl);
  for (const parameter of new Set(databaseUrl.searchParams.keys())) {
    if (DATABASE_URL_TIMEOUT_PARAMETERS.has(parameter.toLowerCase())) {
      databaseUrl.searchParams.delete(parameter);
    }
  }
  const client = new Client({
    connectionString: databaseUrl.toString(),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  await probeDatabaseWithinDeadline(client);
  process.stdout.write('Database check succeeded.\n');
}

main().catch(() => {
  process.stderr.write('Database check failed.\n');
  process.exitCode = 1;
});
