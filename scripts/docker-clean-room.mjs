/* global process, fetch, setTimeout, URL, Buffer */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const CLEAN_ROOM_POSTGRES_DB = 'booking_engine_local';
const CLEAN_ROOM_POSTGRES_USER = 'booking_engine_local';
const CLEAN_ROOM_POSTGRES_PASSWORD = 'local-only-placeholder';

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/docker-clean-room.mjs',
      '',
      'Builds the app with --no-cache --pull, starts a unique Compose project with empty',
      'volumes and isolated ports, runs the real request-to-book/admin smoke, then runs',
      'backup/restore verification before removing only the temporary project resources.',
    ].join('\n') + '\n',
  );
}

function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolveRun({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function freePort() {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not reserve an isolated TCP port.'));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });
}

function composeArgs(project, rest) {
  return ['compose', '--project-name', project, ...rest];
}

function commandError(label, result) {
  const detail = (result.stderr || result.stdout).trim().slice(-2_000);
  return new Error(label + ' failed.' + (detail.length === 0 ? '' : ' Last output: ' + detail));
}

async function waitForHealth(port) {
  const deadline = Date.now() + 120_000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/healthz');
      if (response.status === 200) {
        return;
      }
      lastError = 'HTTP ' + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'connection failed';
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error('clean-room app did not become healthy: ' + lastError);
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const [postgresPort, apiPort, smtpPort, mailpitPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const project = 'booking-engine-hardening-' + process.pid + '-' + Date.now().toString(36);
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    POSTGRES_DB: CLEAN_ROOM_POSTGRES_DB,
    POSTGRES_USER: CLEAN_ROOM_POSTGRES_USER,
    POSTGRES_PASSWORD: CLEAN_ROOM_POSTGRES_PASSWORD,
    POSTGRES_PORT: String(postgresPort),
    API_PORT: String(apiPort),
    MAILPIT_SMTP_PORT: String(smtpPort),
    MAILPIT_UI_PORT: String(mailpitPort),
  };
  let started = false;
  try {
    const build = await run(
      'docker',
      composeArgs(project, ['build', '--no-cache', '--pull', 'app']),
      env,
    );
    if (build.code !== 0) {
      throw commandError('clean-room Docker build', build);
    }
    started = true;
    const up = await run('docker', composeArgs(project, ['up', '-d']), env);
    if (up.code !== 0) {
      throw commandError('clean-room Compose boot', up);
    }
    await waitForHealth(apiPort);
    const smoke = await run(
      'docker',
      composeArgs(project, [
        'exec',
        '-T',
        '-e',
        'SMOKE_BASE_URL=http://127.0.0.1:3000',
        '-e',
        'SMOKE_ADMIN_ORIGIN=http://127.0.0.1:' + apiPort,
        '-e',
        'SMOKE_ADMIN_EMAIL=sample-owner@example.test',
        '-e',
        'SMOKE_ADMIN_PASSWORD=local-only-owner-password',
        '-e',
        'SMOKE_PROPERTY_ID=sample-bungalow',
        '-e',
        'SMOKE_ARRIVAL=2028-08-01',
        '-e',
        'SMOKE_DEPARTURE=2028-08-03',
        '-e',
        'SMOKE_IDEMPOTENCY_KEY=clean-room-smoke-20280801',
        'app',
        'node',
        'scripts/smoke-request-to-book.mjs',
      ]),
      env,
    );
    if (smoke.code !== 0) {
      throw commandError('clean-room request-to-book smoke', smoke);
    }
    if (smoke.stdout.trim().length > 0) {
      process.stdout.write(smoke.stdout.trim() + '\n');
    }
    const backupUrl =
      `postgresql://${CLEAN_ROOM_POSTGRES_USER}:${CLEAN_ROOM_POSTGRES_PASSWORD}` +
      `@127.0.0.1:${postgresPort}/${CLEAN_ROOM_POSTGRES_DB}`;
    const backup = await run(
      process.execPath,
      [
        resolve(root, 'scripts/backup-restore-check.mjs'),
        '--confirm-database',
        CLEAN_ROOM_POSTGRES_DB,
      ],
      {
        ...env,
        BOOKING_ENGINE_ENV: 'local',
        DATABASE_URL: backupUrl,
        DATABASE_SCHEMA: 'public',
        BACKUP_POSTGRES_SERVICE: 'postgres',
      },
    );
    if (backup.code !== 0) {
      throw commandError('clean-room backup/restore', backup);
    }
    if (backup.stdout.trim().length > 0) {
      process.stdout.write(backup.stdout.trim() + '\n');
    }
    process.stdout.write(
      'Docker clean-room passed: no-cache build, empty PostgreSQL boot, real smoke, and backup/restore verification.\n',
    );
  } finally {
    if (started) {
      const down = await run(
        'docker',
        composeArgs(project, ['down', '--volumes', '--remove-orphans']),
        env,
      );
      if (down.code !== 0) {
        process.stderr.write(
          'Clean-room cleanup warning: temporary Compose project did not fully stop.\n',
        );
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'clean-room verification failed';
  process.stderr.write('Docker clean-room failed: ' + message + '\n');
  process.exitCode = 1;
});
