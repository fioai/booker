import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PropertyConfigurationInputV1 } from '../../packages/booking-core/src/index.js';
import {
  createAvailabilityRepository,
  createOrganizationRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createRateRepository,
  runMigrations,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';
import { createPublicBookingHttpServerV1 } from '../../apps/api/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://lotus_booking_local:local-only-placeholder@127.0.0.1:5432/lotus_booking_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `public_api_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;

function makeProperty(id: string, operationalNotes: string): PropertyConfigurationInputV1 {
  return {
    id,
    name: 'Public Contract Bungalow',
    summary: 'A tenant-scoped property used by the public contract test.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'EUR',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: [{ type: 'queen', quantity: 1 }],
    bathroomCount: 1,
    maximumGuests: 2,
    amenities: ['private garden'],
    hostNotes: 'Guest-visible host note.',
    operationalNotes,
  };
}

describe('PostgreSQL-backed public booking REST contract', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let organizationId: string;
  let otherOrganizationId: string;
  let propertyId: string;
  let server: ReturnType<typeof createPublicBookingHttpServerV1> | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationId = `org-a-${testId}`;
    otherOrganizationId = `org-b-${testId}`;
    propertyId = `property-${testId}`;

    const organizations = createOrganizationRepository(database as PostgresDatabasePort);
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    await organizations.create({ id: organizationId, name: 'Public API Tenant A' });
    await organizations.create({ id: otherOrganizationId, name: 'Public API Tenant B' });
    await properties.create(
      { organizationId },
      makeProperty(propertyId, `PRIVATE-${runId}-operational-note`),
    );

    const rates = createRateRepository(database as PostgresDatabasePort);
    await rates.saveRatePlan({ organizationId }, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12500,
      cleaningFeeMinor: 3500,
      minimumStayNights: 2,
    });

    server = createPublicBookingHttpServerV1(
      {
        properties,
        availability: createAvailabilityRepository(database as PostgresDatabasePort),
        rates,
        bookingRequests: createPostgresBookingRequestRepository(database as PostgresDatabasePort),
      },
      { scope: { organizationId } },
    );
    const address = await server.listen(0);
    baseUrl = address.url;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await pool?.query(`DELETE FROM ${table('organizations')} WHERE id = ANY($1::text[])`, [
      [organizationId, otherOrganizationId],
    ]);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
    await pool?.end();
  });

  it('serves property, availability, quote, and request-to-book contracts from PostgreSQL', async () => {
    const propertyResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}`);
    expect(propertyResponse.status).toBe(200);
    const propertyBody = await propertyResponse.json();
    expect(JSON.stringify(propertyBody)).not.toContain(`PRIVATE-${runId}`);
    expect(JSON.stringify(propertyBody)).not.toContain('operationalNotes');

    const availabilityResponse = await fetch(
      `${baseUrl}/v1/properties/${propertyId}/availability?arrival=2026-08-01&departure=2026-08-03`,
    );
    expect(availabilityResponse.status).toBe(200);
    expect(await availabilityResponse.json()).toMatchObject({
      propertyId,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      nights: 2,
      available: true,
    });

    const quoteResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arrival: '2026-08-01', departure: '2026-08-03' }),
    });
    expect(quoteResponse.status).toBe(200);
    expect(await quoteResponse.json()).toMatchObject({
      propertyId,
      currency: 'EUR',
      totalMinor: 28500,
    });

    const requestResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'postgres-contract-key' },
      body: JSON.stringify({
        arrival: '2026-08-01',
        departure: '2026-08-03',
        guestCount: 2,
        guestName: 'Ada Lovelace',
        guestEmail: 'ada@example.test',
        message: 'Please confirm availability.',
      }),
    });
    expect(requestResponse.status).toBe(201);
    const requestBody = await requestResponse.json();
    expect(requestBody).toMatchObject({
      propertyId,
      status: 'pending',
      guestCount: 2,
      quote: { totalMinor: 28500 },
    });
    expect(JSON.stringify(requestBody)).not.toContain('ada@example.test');
    expect(JSON.stringify(requestBody)).not.toContain('Ada Lovelace');
  });

  it('does not cross tenant boundaries and returns stable public errors', async () => {
    await server?.close();
    server = createPublicBookingHttpServerV1(
      {
        properties: createPostgresPropertyRepository(database as PostgresDatabasePort),
        availability: createAvailabilityRepository(database as PostgresDatabasePort),
        rates: createRateRepository(database as PostgresDatabasePort),
        bookingRequests: createPostgresBookingRequestRepository(database as PostgresDatabasePort),
      },
      { scope: { organizationId: otherOrganizationId } },
    );
    const address = await server.listen(0);
    baseUrl = address.url;
    const response = await fetch(`${baseUrl}/v1/properties/${propertyId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'property_not_found', message: 'Property was not found.' },
    });
  });

  it('does not let unauthenticated public submissions block the requested stay', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `public-race-${index}`,
          },
          body: JSON.stringify({
            arrival: '2026-08-01',
            departure: '2026-08-03',
            guestCount: 2,
            guestName: `Unauthenticated ${index}`,
            guestEmail: `unauthenticated-${index}@example.test`,
            message: 'Please confirm availability.',
          }),
        }),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.every((body) => body.status === 'pending')).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain('unauthenticated-');
    const activeInventory = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND status = 'active'`,
      [organizationId, propertyId],
    );
    expect(activeInventory?.rows[0]?.count).toBe('0');
  });
});
