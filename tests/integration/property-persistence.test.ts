import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PropertyConfigurationInput } from '../../packages/booking-core/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresOrganizationRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  runMigrations,
  type AvailabilityRecord,
  type AvailabilityRepository,
  type OrganizationRepository,
  type PostgresDatabasePort,
  type PostgresTransactionPort,
  type PropertyRepository,
  MigrationDriftError,
} from '../../packages/database-postgres/src/index.js';
import { MIGRATION_FILES } from '../../packages/database-postgres/src/database/migrations.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `property_test_${runId}`;
const migrationSchema = `migration_test_${runId}`;
const migrationDriftSchema = `migration_drift_test_${runId}`;

const table = (schema: string, name: string): string => `"${schema}"."${name}"`;

const expectedMigrationIds = MIGRATION_FILES;

const authoritativeMigrationDirectory = new URL(
  '../../packages/database-postgres/migrations/',
  import.meta.url,
);
const expectedMigrationStatuses = expectedMigrationIds.map((id) => ({
  id,
  checksum: createHash('sha256')
    .update(readFileSync(new URL(id, authoritativeMigrationDirectory)))
    .digest('hex'),
}));

function expectMigrationStatuses(
  statuses: readonly { readonly id: string; readonly checksum: string }[],
): void {
  expect(Object.isFrozen(statuses)).toBe(true);
  expect(statuses.map(({ id }) => id)).toEqual(expectedMigrationIds);
  expect(statuses).toEqual(expectedMigrationStatuses);
  for (const status of statuses) {
    expect(Object.isFrozen(status)).toBe(true);
    expect(status.checksum).toMatch(/^[a-f0-9]{64}$/u);
  }
}

interface TransactionQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface TransactionQueryHooks {
  readonly afterQueryStarted?: (query: TransactionQuery) => Promise<void> | void;
  readonly afterQuery?: (query: TransactionQuery) => Promise<void> | void;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wrapTransactionQueries(
  source: PostgresDatabasePort,
  hooks: TransactionQueryHooks,
): PostgresDatabasePort {
  return {
    dialect: source.dialect,
    schema: source.schema,
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      return source.query<Row>(text, values);
    },
    withTransaction<T>(work: (transaction: PostgresTransactionPort) => Promise<T>): Promise<T> {
      return source.withTransaction((transaction) => {
        return work({
          async query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<QueryResult<Row>> {
            const query = { text, values };
            const resultPromise = transaction.query<Row>(text, values);
            await hooks.afterQueryStarted?.(query);
            const result = await resultPromise;
            await hooks.afterQuery?.(query);
            return result;
          },
        });
      });
    },
    close(): Promise<void> {
      return source.close();
    },
  };
}

function makeProperty(id: string, name = 'Tenant A Garden Bungalow'): PropertyConfigurationInput {
  return {
    id,
    name,
    summary: 'A validated tenant-scoped property.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'EUR',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: [
      { type: 'queen', quantity: 1 },
      { type: 'sofa-bed', quantity: 1 },
    ],
    bathroomCount: 1,
    maximumGuests: 3,
    amenities: ['private garden', 'Wi-Fi'],
    hostNotes: 'Guest-visible host note.',
    operationalNotes: `PRIVATE-${runId}-operational-note`,
  };
}

describe('PostgreSQL tenant-safe property persistence', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let organizations: OrganizationRepository;
  let properties: PropertyRepository;
  let availability: AvailabilityRepository;
  let organizationAId: string;
  let organizationBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');

    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
    organizations = createPostgresOrganizationRepository(database);
    properties = createPostgresPropertyRepository(database);
    availability = createPostgresAvailabilityRepository(database);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationAId = `org-a-${testId}`;
    organizationBId = `org-b-${testId}`;
    await organizations.create({ id: organizationAId, name: 'Organization A' });
    await organizations.create({ id: organizationBId, name: 'Organization B' });
  });

  afterEach(async () => {
    if (pool !== undefined) {
      await pool.query(
        `DELETE FROM ${table(integrationSchema, 'organizations')} WHERE id = ANY($1::text[])`,
        [[organizationAId, organizationBId]],
      );
    }
  });

  afterAll(async () => {
    if (database !== undefined) {
      await database.close();
    }

    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
      await pool.end();
    }
  });

  it('persists a valid property within its explicit organization scope', async () => {
    const property = makeProperty(`property-${runId}`);
    const saved = await properties.create({ organizationId: organizationAId }, property);

    expect(saved).toMatchObject({ id: property.id, name: property.name });
    expect(saved.operationalNotes).toBe(property.operationalNotes);
  });

  it('rejects invalid and missing property input before persistence', async () => {
    const property = makeProperty(`property-${runId}`);
    const invalid = { ...property } as Record<string, unknown>;
    delete invalid['name'];

    await expect(
      properties.create({ organizationId: organizationAId }, invalid),
    ).rejects.toMatchObject({
      code: 'property_validation',
      errors: [{ field: 'name', code: 'missing_field' }],
    });
    await expect(properties.create({ organizationId: '' }, property)).rejects.toMatchObject({
      code: 'invalid_organization_id',
    });
    await expect(
      properties.create({ organizationId: `missing-${runId}` }, property),
    ).rejects.toMatchObject({ code: 'organization_not_found' });
  });

  it('bounds organization names in the domain and database', async () => {
    const longName = 'x'.repeat(121);
    await expect(
      organizations.create({ id: `long-name-${runId}`, name: longName }),
    ).rejects.toMatchObject({ code: 'invalid_organization_name' });

    await expect(
      pool?.query(
        `INSERT INTO ${table(integrationSchema, 'organizations')} (id, name) VALUES ($1, $2)`,
        [`direct-long-name-${runId}`, longName],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'organizations_name_max_length' });
  });

  it('keeps application identifier validation aligned with database constraints', async () => {
    const invalidOrganizationId = `bad.id-${runId}`;
    await expect(
      organizations.create({ id: invalidOrganizationId, name: 'Invalid identifier' }),
    ).rejects.toMatchObject({ code: 'invalid_organization_id' });
    await expect(
      pool?.query(
        `INSERT INTO ${table(integrationSchema, 'organizations')} (id, name) VALUES ($1, $2)`,
        [invalidOrganizationId, 'Invalid identifier'],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'organizations_id_format' });

    const property = makeProperty(`property-${runId}`);
    await properties.create({ organizationId: organizationAId }, property);
    await expect(
      pool?.query(
        `UPDATE ${table(integrationSchema, 'properties')} SET id = $1 WHERE organization_id = $2 AND id = $3`,
        [`bad.id-${runId}`, organizationAId, property.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'properties_id_format' });
  });

  it('rejects a duplicate property only within the same organization', async () => {
    const property = makeProperty(`shared-${runId}`);
    await properties.create({ organizationId: organizationAId }, property);

    await expect(
      properties.create({ organizationId: organizationAId }, property),
    ).rejects.toMatchObject({
      code: 'duplicate_property',
    });

    const saved = await properties.create(
      { organizationId: organizationBId },
      makeProperty(property.id, 'Organization B property'),
    );
    expect(saved).toMatchObject({ id: property.id, name: 'Organization B property' });
  });

  it('isolates reads, updates, lists, and deletes by organization', async () => {
    const tenantAProperty = makeProperty(`a-only-${runId}`, 'Tenant A Only Bungalow');
    const sharedProperty = makeProperty(`shared-${runId}`, 'Tenant A Shared Bungalow');
    await properties.create({ organizationId: organizationAId }, tenantAProperty);
    await properties.create(
      { organizationId: organizationBId },
      makeProperty(sharedProperty.id, 'Organization B property'),
    );

    const tenantA = { organizationId: organizationAId };
    const tenantB = { organizationId: organizationBId };
    const fromA = await properties.findById(tenantA, tenantAProperty.id);
    const fromB = await properties.findById(tenantB, tenantAProperty.id);
    expect(fromA).toMatchObject({ id: tenantAProperty.id, name: tenantAProperty.name });
    expect(fromB).toBeNull();

    expect((await properties.list(tenantA)).map((property) => property.id)).toEqual([
      tenantAProperty.id,
    ]);
    expect((await properties.list(tenantB)).map((property) => property.id)).toEqual([
      sharedProperty.id,
    ]);

    const updated = await properties.update(tenantA, tenantAProperty.id, {
      ...tenantAProperty,
      name: 'Tenant A Updated Bungalow',
    });
    expect(updated).toMatchObject({ name: 'Tenant A Updated Bungalow' });
    expect((await properties.findById(tenantB, sharedProperty.id))?.name).toBe(
      'Organization B property',
    );

    expect(
      await properties.update(tenantB, tenantAProperty.id, {
        ...tenantAProperty,
        name: 'Wrong Tenant Update Attempt',
      }),
    ).toBeNull();
    expect(await properties.delete(tenantB, tenantAProperty.id)).toBe(false);
    expect(await properties.delete(tenantA, tenantAProperty.id)).toBe(true);
    expect(await properties.findById(tenantA, tenantAProperty.id)).toBeNull();
    expect(await properties.findById(tenantB, sharedProperty.id)).not.toBeNull();
  });
  it('holds the property mutation lock through the update transaction commit', async () => {
    const property = makeProperty(`mutation-race-${runId}`);
    const scope = { organizationId: organizationAId };
    const sourceDatabase = database as PostgresDatabasePort;
    const directPool = pool as Pool;
    const propertyLockKey = `booking-engine:property:${organizationAId}:${property.id}`;
    const holdId = `mutation-race-hold-${runId}`;
    await properties.create(scope, property);

    const releaseUpdateAfterWrite = createDeferred<void>();
    const updateLockAcquired = createDeferred<TransactionQuery>();
    const updateWritten = createDeferred<TransactionQuery>();
    const lockedProperties = createPostgresPropertyRepository(
      wrapTransactionQueries(sourceDatabase, {
        afterQuery(query) {
          if (query.text.includes('pg_advisory_xact_lock')) {
            updateLockAcquired.resolve(query);
          }
          if (
            query.text.includes(`UPDATE ${table(integrationSchema, 'properties')}`) &&
            query.values?.[0] === organizationAId &&
            query.values?.[1] === property.id
          ) {
            updateWritten.resolve(query);
            return releaseUpdateAfterWrite.promise;
          }
          return undefined;
        },
      }),
    );
    const availabilityLockStarted = createDeferred<TransactionQuery>();
    const availabilityLockAcquired = createDeferred<TransactionQuery>();
    const releaseAvailabilityAfterLock = createDeferred<void>();
    let holdProtectedQueryStarted = false;
    const competingAvailability = createPostgresAvailabilityRepository(
      wrapTransactionQueries(sourceDatabase, {
        afterQueryStarted(query) {
          if (query.text.includes('pg_advisory_xact_lock')) {
            availabilityLockStarted.resolve(query);
            return;
          }
          holdProtectedQueryStarted = true;
        },
        afterQuery(query) {
          if (query.text.includes('pg_advisory_xact_lock')) {
            availabilityLockAcquired.resolve(query);
            return releaseAvailabilityAfterLock.promise;
          }
          return undefined;
        },
      }),
    );

    const updatePromise = lockedProperties.update(scope, property.id, {
      ...property,
      name: 'Mutation Race Updated',
    });
    let holdPromise: Promise<AvailabilityRecord> | undefined;
    try {
      const [propertyLockQuery, updateQuery] = await Promise.all([
        updateLockAcquired.promise,
        updateWritten.promise,
      ]);
      expect(propertyLockQuery.values).toEqual([propertyLockKey]);
      expect(updateQuery.text).toContain(`UPDATE ${table(integrationSchema, 'properties')}`);

      const uncommittedProperty = await properties.findById(scope, property.id);
      expect(uncommittedProperty?.name).toBe(property.name);
      const lockProbe = await directPool.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [propertyLockKey],
      );
      expect(lockProbe.rows).toEqual([{ acquired: false }]);

      holdPromise = competingAvailability.createHold(scope, property.id, {
        id: holdId,
        arrival: '2026-11-01',
        departure: '2026-11-03',
        expiresAt: '2026-11-10T00:00:00.000Z',
      });
      const availabilityLockQuery = await availabilityLockStarted.promise;
      expect(availabilityLockQuery.values).toEqual([propertyLockKey]);
      expect(holdProtectedQueryStarted).toBe(false);

      const beforeCommit = await directPool.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM ${table(integrationSchema, 'availability_blocks')}
          WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        `,
        [organizationAId, property.id, holdId],
      );
      expect(beforeCommit.rows[0]?.count).toBe(0);

      releaseUpdateAfterWrite.resolve();
      const updated = await updatePromise;
      expect(updated).toMatchObject({ id: property.id, name: 'Mutation Race Updated' });
      await expect(properties.findById(scope, property.id)).resolves.toMatchObject({
        id: property.id,
        name: 'Mutation Race Updated',
      });

      const acquiredAvailabilityLockQuery = await availabilityLockAcquired.promise;
      expect(acquiredAvailabilityLockQuery.values).toEqual([propertyLockKey]);
      expect(holdProtectedQueryStarted).toBe(false);
      releaseAvailabilityAfterLock.resolve();

      const hold = await holdPromise;
      expect(hold).toMatchObject({
        id: holdId,
        status: 'held',
        arrival: '2026-11-01',
        departure: '2026-11-03',
      });

      const afterCommit = await directPool.query<{ status: string }>(
        `
          SELECT status
          FROM ${table(integrationSchema, 'availability_blocks')}
          WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        `,
        [organizationAId, property.id, hold.id],
      );
      expect(afterCommit.rows).toEqual([{ status: 'active' }]);
      await availability.releaseHold(scope, property.id, hold.id);
    } finally {
      releaseUpdateAfterWrite.resolve();
      releaseAvailabilityAfterLock.resolve();
      await Promise.allSettled([
        updatePromise,
        ...(holdPromise === undefined ? [] : [holdPromise]),
      ]);
    }
  });

  it('returns a canonical private projection while the SQL view omits operational notes', async () => {
    const property = makeProperty(`public-${runId}`, 'Public Organization B Bungalow');
    await properties.create({ organizationId: organizationBId }, property);

    const publicProperty = await properties.findPublicById(
      { organizationId: organizationBId },
      property.id,
    );
    expect(publicProperty).toMatchObject({ id: property.id, name: property.name });
    expect(publicProperty?.operationalNotes).toBe('public projection validation sentinel');

    const publicProperties = await properties.listPublic({ organizationId: organizationBId });
    expect(publicProperties).toHaveLength(1);
    expect(publicProperties[0]?.operationalNotes).toBe('public projection validation sentinel');

    const columns = await pool?.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'public_properties'
      `,
      [integrationSchema],
    );
    expect(columns?.rows.map(({ column_name }) => column_name)).not.toContain('operational_notes');
  });

  it('serializes concurrent migration runners and remains idempotent', async () => {
    const first = createPostgresDatabase({ connectionString, schema: migrationSchema });
    const second = createPostgresDatabase({ connectionString, schema: migrationSchema });

    try {
      const [firstStatuses, secondStatuses] = await Promise.all([
        runMigrations(first),
        runMigrations(second),
      ]);
      const repeatedStatuses = await runMigrations(first);
      expectMigrationStatuses(firstStatuses);
      expectMigrationStatuses(secondStatuses);
      expectMigrationStatuses(repeatedStatuses);
      expect(secondStatuses).toEqual(firstStatuses);
      expect(repeatedStatuses).toEqual(firstStatuses);

      const result = await pool?.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table(migrationSchema, 'schema_migrations')}`,
      );
      expect(result?.rows[0]?.count).toBe(String(expectedMigrationIds.length));
      await expect(
        pool?.query(`SELECT 1 FROM ${table(migrationSchema, 'organizations')} LIMIT 1`),
      ).resolves.toBeDefined();
    } finally {
      await first.close();
      await second.close();
      await pool?.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
    }
  });
  it('fails closed when an applied migration checksum is tampered', async () => {
    const first = createPostgresDatabase({
      connectionString,
      schema: migrationDriftSchema,
    });
    try {
      const initialStatuses = await runMigrations(first);
      expectMigrationStatuses(initialStatuses);
      const original = await pool?.query<{ checksum: string }>(
        `SELECT checksum FROM ${table(migrationDriftSchema, 'schema_migrations')} WHERE id = $1`,
        ['001_organizations_properties.sql'],
      );
      const originalChecksum = original?.rows[0]?.checksum;
      expect(originalChecksum).toMatch(/^[a-f0-9]{64}$/u);
      await pool?.query(
        `UPDATE ${table(migrationDriftSchema, 'schema_migrations')} SET checksum = $2 WHERE id = $1`,
        ['001_organizations_properties.sql', '0'.repeat(64)],
      );
      await expect(runMigrations(first)).rejects.toBeInstanceOf(MigrationDriftError);
      await pool?.query(
        `UPDATE ${table(migrationDriftSchema, 'schema_migrations')} SET checksum = $2 WHERE id = $1`,
        ['001_organizations_properties.sql', originalChecksum],
      );
      const restoredStatuses = await runMigrations(first);
      expectMigrationStatuses(restoredStatuses);
      expect(restoredStatuses).toEqual(initialStatuses);
    } finally {
      await first.close();
      await pool?.query(`DROP SCHEMA IF EXISTS "${migrationDriftSchema}" CASCADE`);
    }
  });
});
