import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PropertyConfigurationInput } from '../../packages/booking-core/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresOrganizationRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  runMigrations,
  type AvailabilityRepository,
  type OrganizationRepository,
  type PostgresDatabasePort,
  type PropertyRepository,
  MigrationDriftError,
} from '../../packages/database-postgres/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `property_test_${runId}`;
const migrationSchema = `migration_test_${runId}`;
const migrationDriftSchema = `migration_drift_test_${runId}`;

const table = (schema: string, name: string): string => `"${schema}"."${name}"`;

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
  it('serializes property mutation with a concurrent availability decision', async () => {
    const property = makeProperty(`mutation-race-${runId}`);
    const scope = { organizationId: organizationAId };
    await properties.create(scope, property);

    const [updated, hold] = await Promise.all([
      properties.update(scope, property.id, {
        ...property,
        name: 'Mutation Race Updated',
      }),
      availability.createHold(scope, property.id, {
        id: `mutation-race-hold-${runId}`,
        arrival: '2026-11-01',
        departure: '2026-11-03',
        expiresAt: '2026-11-10T00:00:00.000Z',
      }),
    ]);

    expect(updated).toMatchObject({ id: property.id, name: 'Mutation Race Updated' });
    expect(hold).toMatchObject({
      id: `mutation-race-hold-${runId}`,
      status: 'held',
      arrival: '2026-11-01',
      departure: '2026-11-03',
    });
    await availability.releaseHold(scope, property.id, hold.id);
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
      await Promise.all([runMigrations(first), runMigrations(second)]);
      await runMigrations(first);

      const result = await pool?.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table(migrationSchema, 'schema_migrations')}`,
      );
      expect(result?.rows[0]?.count).toBe('10');
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
      await runMigrations(first);
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
      await expect(runMigrations(first)).resolves.toBeUndefined();
    } finally {
      await first.close();
      await pool?.query(`DROP SCHEMA IF EXISTS "${migrationDriftSchema}" CASCADE`);
    }
  });
});
