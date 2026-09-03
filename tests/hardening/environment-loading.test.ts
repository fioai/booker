import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_IDENTITY_KEYS } from '../../scripts/lib/load-environment.mjs';
import { libpqHostArgument } from '../../scripts/backup-restore-check.mjs';
import { validateDatabaseUrl } from '../../scripts/lib/environment.mjs';

const root = resolve(import.meta.dirname, '../..');
const loadEnvironmentUrl = pathToFileURL(resolve(root, 'scripts/lib/load-environment.mjs')).href;
const environmentUrl = pathToFileURL(resolve(root, 'scripts/lib/environment.mjs')).href;
const backupRestoreCheckUrl = pathToFileURL(resolve(root, 'scripts/backup-restore-check.mjs')).href;
const fileDatabasePassword = 'local-only-placeholder';
const explicitDatabasePassword = 'replace_me_local_password';
const localEnvironmentFile = [
  'BOOKING_ENGINE_ENV=local',
  'DATABASE_URL=postgresql://file-user:local-only-placeholder@127.0.0.1:15432/booking_engine_file',
  'DATABASE_SCHEMA=file_schema',
  'HOST=127.0.0.1',
  'PORT=13000',
  'BOOKING_ENGINE_ORGANIZATION_ID=file-tenant',
  'BOOKING_ENGINE_PROPERTY_ID=file-property',
  'ADMIN_ORIGIN=http://127.0.0.1:13000',
  'SECURE_COOKIES=false',
  'BOOKING_ENGINE_SAMPLE_DATA=false',
  'FILE_ONLY_MARKER=complete-file-loaded',
  '',
].join('\n');
const loaderProbe = [
  `import { loadEnvironment } from ${JSON.stringify(loadEnvironmentUrl)};`,
  'const source = loadEnvironment();',
  'process.stdout.write(JSON.stringify({',
  '  source,',
  '  environment: process.env.BOOKING_ENGINE_ENV ?? null,',
  '  schema: process.env.DATABASE_SCHEMA ?? null,',
  '  hasDatabaseUrl: process.env.DATABASE_URL !== undefined,',
  '  fileMarker: process.env.FILE_ONLY_MARKER ?? null,',
  '}));',
].join('\n');
const validationProbe = [
  `import { loadEnvironment } from ${JSON.stringify(loadEnvironmentUrl)};`,
  `import { validateEnvironment } from ${JSON.stringify(environmentUrl)};`,
  'const source = loadEnvironment();',
  'const config = validateEnvironment(process.env);',
  'process.stdout.write(JSON.stringify({',
  '  source,',
  '  environment: config.environment,',
  '  schema: config.schema,',
  '  databaseHost: new URL(config.databaseUrl).hostname,',
  '  fileMarker: process.env.FILE_ONLY_MARKER ?? null,',
  '}));',
].join('\n');
const backupComposeProbe = [
  `import { loadEnvironment } from ${JSON.stringify(loadEnvironmentUrl)};`,
  `import { configureBackupCompose } from ${JSON.stringify(backupRestoreCheckUrl)};`,
  'const source = loadEnvironment();',
  'const compose = configureBackupCompose(source);',
  'const childEnvironment = { ...process.env, ...(compose.childEnvironment ?? {}) };',
  'process.stdout.write(JSON.stringify({',
  '  source,',
  "  commandArguments: compose.commandArguments('compose-probe'),",
  '  composeFile: childEnvironment.COMPOSE_FILE ?? null,',
  '  composeProject: childEnvironment.COMPOSE_PROJECT_NAME ?? null,',
  '  composeEnvFileDisabled: childEnvironment.COMPOSE_DISABLE_ENV_FILE ?? null,',
  '  serviceVariable: childEnvironment.BACKUP_POSTGRES_SERVICE ?? null,',
  '}));',
].join('\n');

function cleanEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of DEPLOYMENT_IDENTITY_KEYS) {
    delete environment[name];
  }
  delete environment['FILE_ONLY_MARKER'];
  delete environment['BACKUP_POSTGRES_SERVICE'];
  delete environment['BACKUP_USE_HOST_TOOLS'];
  delete environment['COMPOSE_FILE'];
  delete environment['COMPOSE_PROJECT_NAME'];
  delete environment['COMPOSE_DISABLE_ENV_FILE'];
  return { ...environment, ...overrides };
}

function runEval(directory: string, program: string, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: directory,
    env: cleanEnvironment(overrides),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function runScript(
  script: string,
  args: readonly string[],
  overrides: NodeJS.ProcessEnv,
  directory = root,
) {
  return spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: directory,
    env: cleanEnvironment(overrides),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const deploymentDatabasePassword = ['deployment', 'password'].join('-');

function deploymentDatabaseUrl(
  host = 'database.internal',
  user = 'deploy-user',
  password = deploymentDatabasePassword,
  database = 'booking_engine',
  query = '?sslmode=verify-full',
): string {
  return ['postgresql://', user, ':', password, '@', host, ':5432/', database, query].join('');
}

function explicitDeploymentEnvironment(): NodeJS.ProcessEnv {
  return {
    BOOKING_ENGINE_ENV: 'staging',
    DATABASE_URL: deploymentDatabaseUrl(
      'database.internal',
      'deploy-user',
      deploymentDatabasePassword,
      'booking_engine_deploy',
    ),
    DATABASE_SCHEMA: 'deployment_schema',
    HOST: '0.0.0.0',
    PORT: '3000',
    BOOKING_ENGINE_ORGANIZATION_ID: 'deployment-tenant',
    BOOKING_ENGINE_PROPERTY_ID: 'deployment-property',
    ADMIN_ORIGIN: 'https://admin.example.com',
    SECURE_COOKIES: 'true',
    BOOKING_ENGINE_SAMPLE_DATA: 'false',
  };
}

function withTemporaryDirectory(run: (directory: string) => void): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'booking-engine-environment-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  return directory;
}

function writeRunnerObservationConfig(directory: string, marker: string): string {
  const config = resolve(directory, 'vitest.config.mjs');
  writeFileSync(
    config,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      '  environment: process.env.BOOKING_ENGINE_ENV ?? null,',
      '  schema: process.env.DATABASE_SCHEMA ?? null,',
      '  databaseHost: new URL(process.env.DATABASE_URL).hostname,',
      '  fileMarker: process.env.FILE_ONLY_MARKER ?? null,',
      '}));',
      "export default { test: { include: ['never/**/*.test.ts'], passWithNoTests: true } };",
      '',
    ].join('\n'),
  );
  return config;
}

const validDeploymentDatabaseUrl = deploymentDatabaseUrl();

describe('database URL deployment policy', () => {
  it.each(['staging', 'production'])('accepts certificate-verified TLS for %s', (environment) => {
    expect(validateDatabaseUrl(validDeploymentDatabaseUrl, environment)).toBe(
      validDeploymentDatabaseUrl,
    );
  });

  it.each([
    ['staging', 'postgresql://deploy-user@database.internal/booking_engine?sslmode=verify-full'],
    [
      'production',
      'postgresql://deploy-user:@database.internal/booking_engine?sslmode=verify-full',
    ],
  ])('rejects a missing password in %s', (environment, databaseUrl) => {
    expect(() => validateDatabaseUrl(databaseUrl, environment)).toThrow(
      'DATABASE_URL must include a non-empty password in staging or production.',
    );
  });

  it.each([
    ['staging', 'replace_me_user', 'real-password'],
    ['production', 'deploy-user', 'local-only-placeholder'],
  ])('rejects placeholder credentials in %s', (environment, user, password) => {
    const databaseUrl = deploymentDatabaseUrl('database.internal', user, password);
    expect(() => validateDatabaseUrl(databaseUrl, environment)).toThrow(
      'DATABASE_URL must not contain placeholder credentials in staging or production.',
    );
  });

  it.each([
    ['staging', 'localhost'],
    ['staging', '127.0.0.1'],
    ['production', '[::1]'],
  ])('rejects loopback host %s in %s', (environment, host) => {
    const databaseUrl = deploymentDatabaseUrl(host);
    expect(() => validateDatabaseUrl(databaseUrl, environment)).toThrow(
      'DATABASE_URL must use a non-loopback host in staging or production.',
    );
  });

  it.each([
    ['', 'missing TLS mode'],
    ['?sslmode=disable', 'disabled TLS'],
    ['?sslmode=prefer', 'prefer TLS'],
    ['?sslmode=require', 'require TLS'],
    ['?sslmode=verify-ca', 'certificate-only TLS'],
    ['?sslmode=no-verify', 'unverified TLS'],
  ])('rejects %s for staging and production (%s)', (query) => {
    for (const environment of ['staging', 'production']) {
      const databaseUrl = deploymentDatabaseUrl(
        'database.internal',
        'deploy-user',
        deploymentDatabasePassword,
        'booking_engine',
        query,
      );
      expect(() => validateDatabaseUrl(databaseUrl, environment)).toThrow(
        'DATABASE_URL must use sslmode=verify-full for certificate-verified PostgreSQL TLS',
      );
    }
  });

  it.each([
    '?sslmode=verify-full&sslmode=verify-full',
    '?sslmode=verify-full&host=attacker.example',
    '?host=attacker.example',
    '?port=6432',
    '?user=attacker',
    '?password=attacker',
    '?%68%6f%73%74=attacker.example',
  ])('rejects endpoint or duplicate query override %s in every environment', (query) => {
    for (const environment of ['local', 'test', 'staging', 'production']) {
      const databaseUrl = deploymentDatabaseUrl(
        'database.internal',
        'deploy-user',
        deploymentDatabasePassword,
        'booking_engine',
        query,
      );
      expect(() => validateDatabaseUrl(databaseUrl, environment)).toThrow();
    }
  });

  it.each(['local', 'test'])('keeps the %s no-TLS workflow valid', (environment) => {
    const databaseUrl =
      'postgresql://local-user:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
    expect(validateDatabaseUrl(databaseUrl, environment)).toBe(databaseUrl);
  });
});

describe('atomic environment loading', () => {
  it('continues without configuration when the optional file and identity variables are absent', () => {
    withTemporaryDirectory((directory) => {
      const result = runEval(directory, loaderProbe);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        source: 'none',
        environment: null,
        schema: null,
        hasDatabaseUrl: false,
        fileMarker: null,
      });
    });
  });

  it('loads the complete file when no identity variable is exported', () => {
    withTemporaryDirectory((directory) => {
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);
      const result = runEval(directory, validationProbe);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        source: 'file',
        environment: 'local',
        schema: 'file_schema',
        databaseHost: '127.0.0.1',
        fileMarker: 'complete-file-loaded',
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
    });
  });

  it.each(DEPLOYMENT_IDENTITY_KEYS)(
    'ignores the complete file when %s is exported as an empty string',
    (identityKey) => {
      withTemporaryDirectory((directory) => {
        writeFileSync(resolve(directory, '.env'), localEnvironmentFile);
        const result = runEval(directory, loaderProbe, { [identityKey]: '' });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          source: 'process',
          environment: identityKey === 'BOOKING_ENGINE_ENV' ? '' : null,
          schema: identityKey === 'DATABASE_SCHEMA' ? '' : null,
          hasDatabaseUrl: identityKey === 'DATABASE_URL',
          fileMarker: null,
        });
        expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
      });
    },
  );

  it('uses a complete explicit deployment environment without loading the local file', () => {
    withTemporaryDirectory((directory) => {
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);
      const result = runEval(directory, validationProbe, explicitDeploymentEnvironment());

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        source: 'process',
        environment: 'staging',
        schema: 'deployment_schema',
        databaseHost: 'database.internal',
        fileMarker: null,
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
      expect(`${result.stdout}${result.stderr}`).not.toContain(explicitDatabasePassword);
    });
  });

  it('disables implicit Compose environment-file routing for a process-selected backup', () => {
    withTemporaryDirectory((directory) => {
      writeFileSync(
        resolve(directory, '.env'),
        [
          'COMPOSE_FILE=rerouted-compose.yml',
          'COMPOSE_PROJECT_NAME=rerouted-project',
          'COMPOSE_DISABLE_ENV_FILE=false',
          'BACKUP_POSTGRES_SERVICE=rerouted-postgres',
          '',
        ].join('\n'),
      );
      const result = runEval(directory, backupComposeProbe, explicitDeploymentEnvironment());

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        source: 'process',
        commandArguments: ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'compose-probe'],
        composeFile: null,
        composeProject: null,
        composeEnvFileDisabled: 'true',
        serviceVariable: null,
      });
    });
  });

  it.each([
    ['postgresql://backup-user:local-only-placeholder@[::1]:15432/booking_engine_test', '::1'],
    [
      'postgresql://backup-user:local-only-placeholder@127.0.0.1:15432/booking_engine_test',
      '127.0.0.1',
    ],
    [
      'postgresql://backup-user:local-only-placeholder@localhost:15432/booking_engine_test',
      'localhost',
    ],
  ])('formats the %s host for a libpq command argument', (databaseUrl, expectedHost) => {
    expect(libpqHostArgument(new URL(databaseUrl).hostname)).toBe(expectedHost);
  });

  it.each([
    ['host routing', 'host=production.example'],
    ['port routing', 'port=6432'],
    ['percent-encoded routing key', '%68%6f%73%74=production.example'],
  ])('rejects backup DATABASE_URL %s query parameters before opening a pool', (_, query) => {
    const result = runScript(
      'scripts/backup-restore-check.mjs',
      ['--confirm-database', 'booking_engine_test'],
      {
        BOOKING_ENGINE_ENV: 'test',
        DATABASE_URL:
          'postgresql://backup-user:local-only-placeholder@127.0.0.1:15432/booking_engine_test?' +
          query,
        DATABASE_SCHEMA: 'public',
        BOOKING_ENGINE_SAMPLE_DATA: 'false',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Backup/restore failed: DATABASE_URL query parameters must be limited to sslmode=verify-full.\n',
    );
  });

  it('accepts the shared verified-TLS URL form before checking the database confirmation', () => {
    const result = runScript(
      'scripts/backup-restore-check.mjs',
      ['--confirm-database', 'wrong_database_name'],
      {
        BOOKING_ENGINE_ENV: 'test',
        DATABASE_URL:
          'postgresql://backup-user:local-only-placeholder@127.0.0.1:15432/booking_engine_test?sslmode=verify-full',
        DATABASE_SCHEMA: 'public',
        BOOKING_ENGINE_SAMPLE_DATA: 'false',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Backup/restore failed: backup/restore requires --confirm-database with the exact decoded DATABASE_URL database name.\n',
    );
  });

  it('rejects a remote backup source before a database pool is opened', () => {
    const remotePassword = 'local-only-placeholder';
    const result = runScript(
      'scripts/backup-restore-check.mjs',
      ['--', '--confirm-database', 'booking_engine_test'],
      {
        BOOKING_ENGINE_ENV: 'test',
        DATABASE_URL:
          'postgresql://backup-user:local-only-placeholder@127.database.example.com/booking_engine_test',
        DATABASE_SCHEMA: 'public',
        BOOKING_ENGINE_SAMPLE_DATA: 'false',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Backup/restore failed: backup/restore requires DATABASE_URL host to be 127.0.0.1, localhost, or ::1.\n',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(remotePassword);
  });

  it('accepts a normal no-query local URL before rejecting a decoded-name mismatch', () => {
    const localPassword = 'local-only-placeholder';
    const result = runScript(
      'scripts/backup-restore-check.mjs',
      ['--confirm-database', 'booking%5Fengine%5Ftest'],
      {
        BOOKING_ENGINE_ENV: 'test',
        DATABASE_URL:
          'postgresql://backup-user:local-only-placeholder@127.0.0.1:15432/booking%5Fengine%5Ftest',
        DATABASE_SCHEMA: 'public',
        BOOKING_ENGINE_SAMPLE_DATA: 'false',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Backup/restore failed: backup/restore requires --confirm-database with the exact decoded DATABASE_URL database name.\n',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(localPassword);
  });

  it('rejects a partial process identity before invoking Vitest', () => {
    withTemporaryDirectory((directory) => {
      const marker = resolve(directory, 'partial-process-invoked.json');
      const config = writeRunnerObservationConfig(directory, marker);
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);

      const result = runScript(
        'scripts/run-integration-tests.mjs',
        ['--config', config, '--passWithNoTests'],
        { HOST: 'deployment.internal' },
        directory,
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Integration test runner failed: BOOKING_ENGINE_ENV is required.\n',
      );
      expect(existsSync(marker)).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
    });
  });

  it('redacts invalid process DATABASE_URL credentials before invoking Vitest', () => {
    withTemporaryDirectory((directory) => {
      const marker = resolve(directory, 'invalid-process-invoked.json');
      const config = writeRunnerObservationConfig(directory, marker);
      const databasePassword = 'runner-validation-secret';

      const result = runScript(
        'scripts/run-integration-tests.mjs',
        ['--config', config, '--passWithNoTests'],
        {
          BOOKING_ENGINE_ENV: 'test',
          DATABASE_URL: `mysql://deploy-user:${databasePassword}@database.internal/booking_engine`,
        },
        directory,
      );

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'Integration test runner failed: DATABASE_URL must use the postgres or postgresql scheme.\n',
      );
      expect(existsSync(marker)).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain(databasePassword);
    });
  });

  it('passes a complete file environment to the integration runner', () => {
    withTemporaryDirectory((directory) => {
      const marker = resolve(directory, 'observed-file-environment.json');
      const config = writeRunnerObservationConfig(directory, marker);
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);

      const result = runScript(
        'scripts/run-integration-tests.mjs',
        ['--config', config, '--passWithNoTests'],
        {},
        directory,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
        environment: 'local',
        schema: 'file_schema',
        databaseHost: '127.0.0.1',
        fileMarker: 'complete-file-loaded',
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
    });
  });

  it('passes only the complete explicit environment to the integration runner', () => {
    withTemporaryDirectory((directory) => {
      const marker = resolve(directory, 'observed-environment.json');
      const config = writeRunnerObservationConfig(directory, marker);
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);

      const result = runScript(
        'scripts/run-integration-tests.mjs',
        ['--config', config, '--passWithNoTests'],
        explicitDeploymentEnvironment(),
        directory,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
        environment: 'staging',
        schema: 'deployment_schema',
        databaseHost: 'database.internal',
        fileMarker: null,
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
      expect(`${result.stdout}${result.stderr}`).not.toContain(explicitDatabasePassword);
    });
  });

  it('returns the Vitest failure status without loading the local file', () => {
    const temporaryDirectory = withTemporaryDirectory((directory) => {
      const marker = resolve(directory, 'observed-failing-environment.json');
      const config = resolve(directory, 'vitest.config.mjs');
      const integrationDirectory = resolve(directory, 'tests/integration');
      const failingTest = resolve(integrationDirectory, 'controlled-failure.test.mjs');
      mkdirSync(integrationDirectory, { recursive: true });
      writeFileSync(resolve(directory, '.env'), localEnvironmentFile);
      writeFileSync(
        config,
        [
          'export default {',
          `  root: ${JSON.stringify(directory)},`,
          '  test: {',
          '    globals: true,',
          "    include: ['tests/integration/**/*.test.mjs'],",
          '  },',
          '};',
          '',
        ].join('\n'),
      );
      writeFileSync(
        failingTest,
        [
          "import { writeFileSync } from 'node:fs';",
          '',
          "test('controlled integration failure', () => {",
          `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
          '    environment: process.env.BOOKING_ENGINE_ENV ?? null,',
          '    schema: process.env.DATABASE_SCHEMA ?? null,',
          '    databaseHost: new URL(process.env.DATABASE_URL).hostname,',
          '    fileMarker: process.env.FILE_ONLY_MARKER ?? null,',
          '  }));',
          "  throw new Error('controlled integration failure');",
          '});',
          '',
        ].join('\n'),
      );

      const result = runScript(
        'scripts/run-integration-tests.mjs',
        ['--config', config],
        explicitDeploymentEnvironment(),
        directory,
      );

      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
        environment: 'staging',
        schema: 'deployment_schema',
        databaseHost: 'database.internal',
        fileMarker: null,
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(fileDatabasePassword);
      expect(`${result.stdout}${result.stderr}`).not.toContain(explicitDatabasePassword);
    });

    expect(existsSync(temporaryDirectory)).toBe(false);
  });
});
