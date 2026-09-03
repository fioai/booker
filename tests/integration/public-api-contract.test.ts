import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PropertyConfigurationInput } from '../../packages/booking-core/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresOrganizationRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createPostgresRateRepository,
  runMigrations,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';
import { createApiHttpServer } from '../../apps/api/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `public_api_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;

function makeProperty(id: string, operationalNotes: string): PropertyConfigurationInput {
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
  let server: ReturnType<typeof createApiHttpServer> | undefined;
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

    const organizations = createPostgresOrganizationRepository(database as PostgresDatabasePort);
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    await organizations.create({ id: organizationId, name: 'Public API Tenant A' });
    await organizations.create({ id: otherOrganizationId, name: 'Public API Tenant B' });
    await properties.create(
      { organizationId },
      makeProperty(propertyId, `PRIVATE-${runId}-operational-note`),
    );

    const rates = createPostgresRateRepository(database as PostgresDatabasePort);
    await rates.saveRatePlan({ organizationId }, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12500,
      cleaningFeeMinor: 3500,
      minimumStayNights: 2,
    });

    server = createApiHttpServer(
      {
        properties,
        availability: createPostgresAvailabilityRepository(database as PostgresDatabasePort),
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

  it('replays the stored request after rate and capacity changes without creating another record', async () => {
    const body = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
      message: 'Please confirm availability.',
    };
    const firstResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mutable-replay-key' },
      body: JSON.stringify(body),
    });
    expect(firstResponse.status).toBe(201);
    const firstBody = await firstResponse.json();
    if (
      typeof firstBody !== 'object' ||
      firstBody === null ||
      !('id' in firstBody) ||
      typeof firstBody.id !== 'string'
    ) {
      throw new Error('request response must include an id.');
    }

    const requests = createPostgresBookingRequestRepository(database as PostgresDatabasePort);
    await requests.approve({ organizationId }, propertyId, firstBody.id);
    await pool?.query(
      `UPDATE ${table('properties')} SET maximum_guests = 1 WHERE organization_id = $1 AND id = $2`,
      [organizationId, propertyId],
    );
    await pool?.query(
      `DELETE FROM ${table('property_rate_plans')} WHERE organization_id = $1 AND property_id = $2`,
      [organizationId, propertyId],
    );

    const replayResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mutable-replay-key' },
      body: JSON.stringify(body),
    });
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toEqual({ ...firstBody, status: 'approved' });

    const changedBodyResponse = await fetch(
      `${baseUrl}/v1/properties/${propertyId}/request-to-book`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'mutable-replay-key' },
        body: JSON.stringify({ ...body, message: 'A different request.' }),
      },
    );
    expect(changedBodyResponse.status).toBe(409);
    expect(await changedBodyResponse.json()).toMatchObject({
      error: { code: 'request_conflict' },
    });

    const otherPropertyId = `other-property-${runId}`;
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    await properties.create({ organizationId }, makeProperty(otherPropertyId, 'Other property.'));
    const changedPropertyResponse = await fetch(
      `${baseUrl}/v1/properties/${otherPropertyId}/request-to-book`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'mutable-replay-key' },
        body: JSON.stringify(body),
      },
    );
    expect(changedPropertyResponse.status).toBe(409);
    expect(await changedPropertyResponse.json()).toMatchObject({
      error: { code: 'request_conflict' },
    });

    const persisted = await pool?.query<{ requests: string; events: string }>(
      `
        SELECT
          (SELECT count(*)::text FROM ${table('booking_requests')}) AS requests,
          (SELECT count(*)::text FROM ${table('booking_outbox')}) AS events
        WHERE EXISTS (
          SELECT 1
          FROM ${table('booking_requests')}
          WHERE organization_id = $1 AND idempotency_key = $2
        )
      `,
      [organizationId, 'mutable-replay-key'],
    );
    expect(persisted?.rows).toEqual([{ requests: '1', events: '2' }]);
  });

  it('persists exact Unicode text limits and rejects the next code point', async () => {
    const astralCodePoint = '😀';
    const exactInput = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: astralCodePoint.repeat(120),
      guestEmail: `${astralCodePoint.repeat(241)}@example.test`,
      message: astralCodePoint.repeat(2_000),
    };
    const submit = (idempotencyKey: string, body: Readonly<Record<string, unknown>>) =>
      fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      });
    const idempotencyKey = `unicode-boundary-${runId}`;

    const acceptedResponse = await submit(idempotencyKey, exactInput);
    expect(acceptedResponse.status).toBe(201);
    const acceptedBody = await acceptedResponse.json();

    const retryResponse = await submit(idempotencyKey, exactInput);
    expect(retryResponse.status).toBe(201);
    expect(await retryResponse.json()).toEqual(acceptedBody);

    const mismatchResponse = await submit(idempotencyKey, {
      ...exactInput,
      message: `${astralCodePoint.repeat(1_999)}🚀`,
    });
    expect(mismatchResponse.status).toBe(409);
    expect(await mismatchResponse.json()).toMatchObject({
      error: { code: 'request_conflict' },
    });

    const maximumPlusOneCases = [
      {
        field: 'guestName',
        idempotencyKey: `unicode-name-over-${runId}`,
        body: { ...exactInput, guestName: astralCodePoint.repeat(121) },
      },
      {
        field: 'guestEmail',
        idempotencyKey: `unicode-email-over-${runId}`,
        body: {
          ...exactInput,
          guestEmail: `${astralCodePoint.repeat(242)}@example.test`,
        },
      },
      {
        field: 'message',
        idempotencyKey: `unicode-message-over-${runId}`,
        body: { ...exactInput, message: astralCodePoint.repeat(2_001) },
      },
    ] as const;
    for (const boundaryCase of maximumPlusOneCases) {
      const response = await submit(boundaryCase.idempotencyKey, boundaryCase.body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'validation_failed',
          details: expect.arrayContaining([
            expect.objectContaining({
              field: boundaryCase.field,
              code: 'string_too_long',
            }),
          ]),
        },
      });
    }

    const persisted = await pool?.query<{
      request_count: number;
      request_id: string;
      request_fingerprint: string;
      guest_name_length: number;
      guest_email_length: number;
      message_length: number;
    }>(
      `
        SELECT
          (
            SELECT count(*)::integer
            FROM ${table('booking_requests')}
            WHERE organization_id = $1
          ) AS request_count,
          request_id,
          request_fingerprint,
          char_length(guest_name)::integer AS guest_name_length,
          char_length(guest_email)::integer AS guest_email_length,
          char_length(message)::integer AS message_length
        FROM ${table('booking_requests')}
        WHERE organization_id = $1 AND idempotency_key = $2
      `,
      [organizationId, idempotencyKey],
    );
    expect(persisted?.rows).toEqual([
      {
        request_count: 1,
        request_id: acceptedBody.id,
        request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        guest_name_length: 120,
        guest_email_length: 254,
        message_length: 2_000,
      },
    ]);
  });

  it('does not cross tenant boundaries and returns stable public errors', async () => {
    await server?.close();
    server = createApiHttpServer(
      {
        properties: createPostgresPropertyRepository(database as PostgresDatabasePort),
        availability: createPostgresAvailabilityRepository(database as PostgresDatabasePort),
        rates: createPostgresRateRepository(database as PostgresDatabasePort),
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
