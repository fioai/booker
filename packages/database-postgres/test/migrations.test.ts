import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PostgresDatabasePort, PostgresTransactionPort } from '../src/index.js';
import { MigrationDriftError, runMigrationsFromDirectory } from '../src/database/migrations.js';

function fakeDatabase(appliedChecksums: Readonly<Record<string, string | null>>) {
  const storedChecksums = new Map(Object.entries(appliedChecksums));
  const state = { checksumNotNull: false };
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    if (text.includes('SELECT id, checksum FROM')) {
      const id = values?.[0];
      if (typeof id !== 'string') {
        throw new Error('Migration lookup did not provide an ID.');
      }
      const rows = storedChecksums.has(id) ? [{ id, checksum: storedChecksums.get(id) }] : [];
      return { rows, rowCount: rows.length };
    }

    if (text.includes('ALTER COLUMN checksum SET NOT NULL')) {
      if ([...storedChecksums.values()].some((storedChecksum) => storedChecksum === null)) {
        throw Object.assign(new Error('checksum contains null values.'), { code: '23502' });
      }
      state.checksumNotNull = true;
      return { rows: [], rowCount: 0 };
    }

    if (
      text.includes('schema_migrations') &&
      (text.includes('SET checksum = $2') || text.includes('(id, checksum) VALUES ($1, $2)'))
    ) {
      const id = values?.[0];
      const storedChecksum = values?.[1];
      if (
        typeof id !== 'string' ||
        (typeof storedChecksum !== 'string' && storedChecksum !== null)
      ) {
        throw new Error('Migration checksum write did not provide an ID and checksum.');
      }
      if (storedChecksum === null && state.checksumNotNull) {
        throw Object.assign(new Error('checksum violates the not-null constraint.'), {
          code: '23502',
        });
      }
      storedChecksums.set(id, storedChecksum);
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });
  const transaction = { query } as unknown as PostgresTransactionPort;
  const database = {
    dialect: 'postgres',
    schema: 'test',
    query,
    async withTransaction<T>(
      work: (transaction: PostgresTransactionPort) => Promise<T>,
    ): Promise<T> {
      const storedChecksumsBefore = new Map(storedChecksums);
      const checksumNotNullBefore = state.checksumNotNull;
      try {
        return await work(transaction);
      } catch (error) {
        storedChecksums.clear();
        for (const [id, storedChecksum] of storedChecksumsBefore) {
          storedChecksums.set(id, storedChecksum);
        }
        state.checksumNotNull = checksumNotNullBefore;
        throw error;
      }
    },
    close: vi.fn(async () => undefined),
  } as unknown as PostgresDatabasePort;

  return { database, query, state, storedChecksums };
}

describe('PostgreSQL migration status', () => {
  it('returns every explicit migration in manifest order with verified immutable checksums', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booking-engine-migration-status-'));
    const migrationFiles = ['002_second.sql', '001_first.sql'] as const;
    const secondChecksum = '83b969f7dbc2d94e8465e868abe9d60f6b342610c50fb6907d3c7d806365c4c8';

    try {
      await Promise.all([
        writeFile(join(directory, migrationFiles[0]), 'CREATE TABLE second_table (id TEXT);\n'),
        writeFile(join(directory, migrationFiles[1]), 'CREATE TABLE first_table (id TEXT);\n'),
      ]);

      const fake = fakeDatabase({ [migrationFiles[0]]: secondChecksum });
      const statuses = await runMigrationsFromDirectory(fake.database, directory, migrationFiles);

      expect(statuses).toEqual([
        { id: migrationFiles[0], checksum: secondChecksum },
        {
          id: migrationFiles[1],
          checksum: '785b2f6796ad9bca81cad32669122b07e973964ec597321e37478558b02de829',
        },
      ]);
      expect(Object.isFrozen(statuses)).toBe(true);
      expect(statuses.every((status) => Object.isFrozen(status))).toBe(true);
      expect(fake.query.mock.calls.some(([text]) => text.includes('checksum TEXT NOT NULL'))).toBe(
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('baselines a legacy null checksum once and enforces the database constraint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booking-engine-legacy-migration-'));
    const migrationFiles = ['001_legacy.sql'] as const;
    const migrationId = migrationFiles[0];

    try {
      await writeFile(join(directory, migrationId), 'CREATE TABLE legacy_table (id TEXT);\n');
      const fake = fakeDatabase({ [migrationId]: null });

      const firstStatuses = await runMigrationsFromDirectory(
        fake.database,
        directory,
        migrationFiles,
      );
      const currentChecksum = firstStatuses[0]?.checksum;
      expect(currentChecksum).toMatch(/^[a-f0-9]{64}$/u);
      expect(fake.storedChecksums.get(migrationId)).toBe(currentChecksum);
      expect(fake.state.checksumNotNull).toBe(true);

      const firstBaselineUpdates = fake.query.mock.calls.filter(
        ([text, values]) =>
          text.includes('SET checksum = $2') &&
          values?.[0] === migrationId &&
          values?.[1] === currentChecksum,
      );
      expect(firstBaselineUpdates).toHaveLength(1);

      const repeatedStatuses = await runMigrationsFromDirectory(
        fake.database,
        directory,
        migrationFiles,
      );
      expect(repeatedStatuses).toEqual(firstStatuses);
      const repeatedBaselineUpdates = fake.query.mock.calls.filter(
        ([text, values]) =>
          text.includes('SET checksum = $2') &&
          values?.[0] === migrationId &&
          values?.[1] === currentChecksum,
      );
      expect(repeatedBaselineUpdates).toHaveLength(1);

      await expect(
        fake.database.query('UPDATE "test"."schema_migrations" SET checksum = $2 WHERE id = $1', [
          migrationId,
          null,
        ]),
      ).rejects.toMatchObject({ code: '23502' });

      await fake.database.query(
        'UPDATE "test"."schema_migrations" SET checksum = $2 WHERE id = $1',
        [migrationId, '0'.repeat(64)],
      );
      await expect(
        runMigrationsFromDirectory(fake.database, directory, migrationFiles),
      ).rejects.toBeInstanceOf(MigrationDriftError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails the constraint step when a legacy row is not in the manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'booking-engine-unknown-migration-'));
    const migrationFiles = ['001_known.sql'] as const;

    try {
      await writeFile(join(directory, migrationFiles[0]), 'CREATE TABLE known_table (id TEXT);\n');
      const fake = fakeDatabase({
        [migrationFiles[0]]: null,
        '000_unknown.sql': null,
      });

      await expect(
        runMigrationsFromDirectory(fake.database, directory, migrationFiles),
      ).rejects.toMatchObject({ code: '23502' });
      expect(fake.state.checksumNotNull).toBe(false);
      expect(fake.storedChecksums.get(migrationFiles[0])).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
