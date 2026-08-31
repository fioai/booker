/* global process, URL, Buffer */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateEnvironment } from './lib/environment.mjs';
import { loadEnvironment } from './lib/load-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const TABLES = [
  'organizations',
  'properties',
  'property_rate_plans',
  'seasonal_rate_overrides',
  'availability_blocks',
  'ical_blocks',
  'booking_requests',
  'booking_outbox',
  'owner_identities',
  'organization_memberships',
  'admin_sessions',
  'payment_checkouts',
  'payment_provider_events',
];
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/u;

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/backup-restore-check.mjs --confirm-database <decoded-name>',
      '',
      'Requires BOOKING_ENGINE_ENV=local|test, DATABASE_URL, an exact database-name confirmation,',
      'and a literal loopback PostgreSQL host: 127.0.0.1, localhost, or ::1.',
      'Uses pg_dump/pg_restore from the configured Docker Compose postgres service when host tools',
      'are unavailable. The temporary restore database is created and removed only with a hard prefix.',
    ].join('\n') + '\n',
  );
}

function quoteIdentifier(value) {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error('database identifier is outside the bounded restore pattern.');
  }
  return '"' + value + '"';
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolveProcess({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function connectionParts(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  if (!database || !user) {
    throw new Error('DATABASE_URL must include a database and user for backup verification.');
  }
  return {
    url,
    database,
    user,
    password: decodeURIComponent(url.password),
  };
}

function requireDatabaseUrlWithoutQuery(url) {
  if (url.search.length > 0) {
    throw new Error('backup/restore DATABASE_URL must not contain query parameters.');
  }
}

function requireConfirmedDatabase(args, expectedDatabase) {
  const commandArguments = args[0] === '--' ? args.slice(1) : args;
  if (
    commandArguments.length !== 2 ||
    commandArguments[0] !== '--confirm-database' ||
    commandArguments[1].length === 0 ||
    commandArguments[1] !== expectedDatabase
  ) {
    throw new Error(
      'backup/restore requires --confirm-database with the exact decoded DATABASE_URL database name.',
    );
  }
}

function requirePostgresServiceSelector() {
  const service = process.env.BACKUP_POSTGRES_SERVICE?.trim() || 'postgres';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(service)) {
    throw new Error('BACKUP_POSTGRES_SERVICE must be a lowercase Docker Compose service selector.');
  }
  return service;
}

function requireLocalDatabaseHost(url) {
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (!loopback) {
    throw new Error(
      'backup/restore requires DATABASE_URL host to be 127.0.0.1, localhost, or ::1.',
    );
  }
}

export function libpqHostArgument(hostname) {
  return hostname === '[::1]' ? '::1' : hostname;
}

function composeArgs(service, shellCommand) {
  const args = ['compose'];
  const project = process.env.COMPOSE_PROJECT_NAME?.trim();
  if (project !== undefined && project.length > 0) {
    args.push('--project-name', project);
  }
  args.push('exec', '-T', service, 'sh', '-c', shellCommand);
  return args;
}

export function configureBackupCompose(environmentSource) {
  const service = requirePostgresServiceSelector();
  let childEnvironment;
  switch (environmentSource) {
    case 'process':
      childEnvironment = Object.freeze({ COMPOSE_DISABLE_ENV_FILE: 'true' });
      break;
    case 'file':
    case 'none':
      childEnvironment = undefined;
      break;
    default:
      throw new Error('backup/restore received an unknown environment source.');
  }
  return Object.freeze({
    childEnvironment,
    commandArguments(shellCommand) {
      return composeArgs(service, shellCommand);
    },
  });
}

async function runPostgresTool(tool, compose, parts, database, input) {
  const hostTool = process.env.BACKUP_USE_HOST_TOOLS === 'true';
  if (hostTool) {
    const host = libpqHostArgument(parts.url.hostname);
    const command = tool === 'pg_dump' ? 'pg_dump' : 'pg_restore';
    const args =
      tool === 'pg_dump'
        ? [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            '--host',
            host,
            '--port',
            String(parts.url.port || 5432),
            '--username',
            parts.user,
            '--dbname',
            database,
          ]
        : [
            '--no-owner',
            '--no-acl',
            '--exit-on-error',
            '--host',
            host,
            '--port',
            String(parts.url.port || 5432),
            '--username',
            parts.user,
            '--dbname',
            database,
          ];
    const result = await runProcess(command, args, { env: { PGPASSWORD: parts.password }, input });
    if (result.code !== 0) {
      throw new Error(tool + ' failed using host PostgreSQL tools.');
    }
    return result.stdout;
  }
  const safeUser = shellQuote(parts.user);
  const safeDatabase = shellQuote(database);
  const command =
    tool === 'pg_dump'
      ? 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --no-acl --host=127.0.0.1 --port=5432 --username=' +
        safeUser +
        ' --dbname=' +
        safeDatabase
      : 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --no-owner --no-acl --exit-on-error --username=' +
        safeUser +
        ' --dbname=' +
        safeDatabase;
  const result = await runProcess('docker', compose.commandArguments(command), {
    env: compose.childEnvironment,
    input,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().slice(-1_000);
    throw new Error(
      tool +
        ' failed inside the isolated PostgreSQL service.' +
        (detail.length === 0 ? '' : ' PostgreSQL reported: ' + detail),
    );
  }
  return result.stdout;
}

function table(schema, name) {
  return quoteIdentifier(schema) + '.' + quoteIdentifier(name);
}

async function tableCounts(pool, schema) {
  const counts = {};
  for (const name of TABLES) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ' + table(schema, name));
    counts[name] = result.rows[0]?.count ?? 0;
  }
  return counts;
}

async function verifySnapshot(pool, schema, expectedCounts) {
  const actualCounts = await tableCounts(pool, schema);
  if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts)) {
    throw new Error('restored table row counts do not match the source snapshot.');
  }
  const constraint = await pool.query(
    [
      'SELECT COUNT(*)::int AS count FROM pg_constraint AS constraint_row',
      'INNER JOIN pg_namespace AS namespace_row ON namespace_row.oid = constraint_row.connamespace',
      'WHERE namespace_row.nspname = $1 AND constraint_row.conname = ANY($2::text[])',
    ].join('\n'),
    [schema, ['availability_blocks_active_stay_exclusion', 'seasonal_rate_overrides_no_overlap']],
  );
  if (constraint.rows[0]?.count !== 2) {
    throw new Error('restored PostgreSQL overlap exclusion invariant is missing.');
  }
  const overlap = await pool.query(
    [
      'SELECT COUNT(*)::int AS count',
      'FROM ' + table(schema, 'availability_blocks') + ' AS left_block',
      'INNER JOIN ' + table(schema, 'availability_blocks') + ' AS right_block',
      '  ON left_block.organization_id = right_block.organization_id',
      ' AND left_block.property_id = right_block.property_id',
      ' AND left_block.record_id < right_block.record_id',
      "WHERE left_block.status = 'active' AND right_block.status = 'active'",
      '  AND left_block.stay && right_block.stay',
    ].join('\n'),
  );
  if (overlap.rows[0]?.count !== 0) {
    throw new Error('restored active availability rows overlap.');
  }
  const orphan = await pool.query(
    [
      'SELECT COUNT(*)::int AS count',
      'FROM ' + table(schema, 'booking_requests') + ' AS request_row',
      'LEFT JOIN ' + table(schema, 'properties') + ' AS property_row',
      '  ON property_row.organization_id = request_row.organization_id',
      ' AND property_row.id = request_row.property_id',
      'WHERE property_row.id IS NULL',
    ].join('\n'),
  );
  if (orphan.rows[0]?.count !== 0) {
    throw new Error('restored booking requests contain an orphaned property reference.');
  }
  return actualCounts;
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const environmentSource = loadEnvironment();
  const config = validateEnvironment(process.env, { requireApplicationScope: false });
  if (config.environment !== 'local' && config.environment !== 'test') {
    throw new Error('backup/restore verification is limited to local and test environments.');
  }
  const parts = connectionParts(config.databaseUrl);
  requireDatabaseUrlWithoutQuery(parts.url);
  requireLocalDatabaseHost(parts.url);
  const compose = configureBackupCompose(environmentSource);
  requireConfirmedDatabase(process.argv.slice(2), parts.database);
  const schema = config.schema;
  const { Pool } = await import('pg');
  const sourcePool = new Pool({ connectionString: config.databaseUrl });
  const adminUrl = new URL(parts.url.toString());
  adminUrl.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  const targetName = 'booking_engine_restore_' + process.pid + '_' + Date.now().toString(36);
  const targetUrl = new URL(parts.url.toString());
  targetUrl.pathname = '/' + targetName;
  let targetCreated = false;
  let tempDirectory;
  try {
    await sourcePool.query('SELECT 1');
    const sourceCounts = await tableCounts(sourcePool, schema);
    if (
      sourceCounts.organizations < 1 ||
      sourceCounts.properties < 1 ||
      sourceCounts.property_rate_plans < 1
    ) {
      throw new Error(
        'source database must contain migrated property and rate data before backup.',
      );
    }
    await adminPool.query('CREATE DATABASE ' + quoteIdentifier(targetName));
    targetCreated = true;
    const targetEmptyPool = new Pool({ connectionString: targetUrl.toString() });
    try {
      const targetTables = await targetEmptyPool.query(
        'SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
        [schema, TABLES],
      );
      if (targetTables.rows[0]?.count !== 0) {
        throw new Error('restore target was not empty before pg_restore.');
      }
    } finally {
      await targetEmptyPool.end();
    }
    const dump = await runPostgresTool('pg_dump', compose, parts, parts.database);
    if (dump.byteLength < 128) {
      throw new Error('pg_dump produced an unexpectedly small backup.');
    }
    tempDirectory = await mkdtemp(resolve(tmpdir(), 'booking-engine-backup-'));
    const dumpPath = resolve(tempDirectory, 'source.dump');
    await writeFile(dumpPath, dump, { mode: 0o600 });
    const restoreInput = await readFile(dumpPath);
    await runPostgresTool('pg_restore', compose, parts, targetName, restoreInput);
    const targetPool = new Pool({ connectionString: targetUrl.toString() });
    try {
      await targetPool.query('SELECT 1');
      const restoredCounts = await verifySnapshot(targetPool, schema, sourceCounts);
      process.stdout.write(
        'Backup/restore passed: custom dump bytes=' +
          dump.byteLength +
          '; verified tables=' +
          Object.keys(restoredCounts).length +
          '; overlap, foreign-key, and row-count invariants passed.\n',
      );
    } finally {
      await targetPool.end();
    }
  } finally {
    await sourcePool.end();
    if (targetCreated) {
      await adminPool
        .query('DROP DATABASE ' + quoteIdentifier(targetName) + ' WITH (FORCE)')
        .catch(() => undefined);
    }
    await adminPool.end();
    if (tempDirectory !== undefined) {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'backup/restore verification failed';
    process.stderr.write('Backup/restore failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
