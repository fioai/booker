import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { cleanupBackupResources, observeBackupPool } from '../../scripts/backup-restore-check.mjs';

const root = resolve(import.meta.dirname, '../..');
const backupScript = resolve(root, 'scripts/backup-restore-check.mjs');
const cleanRoomDatabaseUrl =
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';

class FakePool {
  readonly events: string[];
  readonly label: string;
  readonly listeners = new Set<(error: unknown) => void>();
  ended = false;
  queryCalls = 0;

  constructor(label: string, events: string[]) {
    this.label = label;
    this.events = events;
  }

  on(event: 'error', listener: (error: unknown) => void): void {
    if (event !== 'error') {
      throw new Error('unexpected fake pool event');
    }
    this.listeners.add(listener);
  }

  removeListener(event: 'error', listener: (error: unknown) => void): void {
    if (event !== 'error') {
      throw new Error('unexpected fake pool event');
    }
    this.listeners.delete(listener);
  }

  query(...args: unknown[]): Promise<unknown> {
    void args;
    this.queryCalls += 1;
    this.events.push(this.label + '.query');
    return Promise.resolve({ rows: [] });
  }

  end(): Promise<unknown> {
    this.events.push(this.label + '.end');
    this.ended = true;
    return Promise.resolve();
  }

  emitError(error: unknown): void {
    for (const listener of this.listeners) {
      listener(error);
    }
  }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    'BOOKING_ENGINE_ENV',
    'DATABASE_URL',
    'DATABASE_SCHEMA',
    'HOST',
    'PORT',
    'BOOKING_ENGINE_ORGANIZATION_ID',
    'BOOKING_ENGINE_PROPERTY_ID',
    'ADMIN_ORIGIN',
    'SECURE_COOKIES',
    'BOOKING_ENGINE_SAMPLE_DATA',
    'BOOKING_ENGINE_SAMPLE_PASSWORD',
    'BACKUP_POSTGRES_SERVICE',
    'BACKUP_USE_HOST_TOOLS',
    'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME',
    'COMPOSE_DISABLE_ENV_FILE',
  ]) {
    delete environment[name];
  }
  return environment;
}

describe('backup/restore resource lifecycle', () => {
  it('closes the target pool before dropping its temporary database', async () => {
    const events: string[] = [];
    const target = new FakePool('target', events);
    const source = new FakePool('source', events);
    const admin = new FakePool('admin', events);

    await cleanupBackupResources({
      targetPool: observeBackupPool(target),
      targetEmptyPool: undefined,
      sourcePool: observeBackupPool(source),
      adminPool: observeBackupPool(admin),
      targetCreated: true,
      dropTarget: async () => {
        events.push('drop');
        expect(target.ended).toBe(true);
      },
    });

    expect(events).toEqual(['target.end', 'source.end', 'drop', 'admin.end']);
  });

  it('reports an unexpected pool error after all cleanup without exposing its details', async () => {
    const events: string[] = [];
    const target = new FakePool('target', events);
    const source = new FakePool('source', events);
    const admin = new FakePool('admin', events);
    const targetResource = observeBackupPool(target);

    for (let index = 0; index < 17; index += 1) {
      await target.query('SELECT ' + index);
    }
    expect(target.queryCalls).toBe(17);
    target.emitError(new Error('password=connection-secret'));

    await expect(
      cleanupBackupResources({
        targetPool: targetResource,
        targetEmptyPool: undefined,
        sourcePool: observeBackupPool(source),
        adminPool: observeBackupPool(admin),
        targetCreated: false,
        dropTarget: undefined,
      }),
    ).rejects.toThrow(
      'backup/restore PostgreSQL connection failed during verification or cleanup.',
    );
    expect(events.filter((event) => event.endsWith('.end'))).toEqual([
      'target.end',
      'source.end',
      'admin.end',
    ]);
    expect(events.join('\n')).not.toContain('connection-secret');
  });
});

describe('clean-room backup environment', () => {
  it('validates the exact local Compose backup options before opening a database pool', () => {
    const result = spawnSync(
      process.execPath,
      [backupScript, '--confirm-database', 'wrong_database_name'],
      {
        cwd: root,
        env: {
          ...cleanEnvironment(),
          COMPOSE_PROJECT_NAME: 'booking-engine-hardening-regression',
          POSTGRES_DB: 'booking_engine_local',
          POSTGRES_USER: 'booking_engine_local',
          POSTGRES_PASSWORD: 'local-only-placeholder',
          POSTGRES_PORT: '15432',
          API_PORT: '13000',
          MAILPIT_SMTP_PORT: '11025',
          MAILPIT_UI_PORT: '18025',
          BOOKING_ENGINE_ENV: 'local',
          DATABASE_URL: cleanRoomDatabaseUrl,
          DATABASE_SCHEMA: 'public',
          BACKUP_POSTGRES_SERVICE: 'postgres',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Backup/restore failed: backup/restore requires --confirm-database with the exact decoded DATABASE_URL database name.\n',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain('local-only-placeholder');
  });
});
