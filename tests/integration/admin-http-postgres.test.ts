import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  PropertyConfigurationInput,
  QuoteBreakdown,
} from '../../packages/booking-core/src/index.js';
import {
  createAdminHttpApi,
  createPostgresAdminSessionStore,
  hashOwnerPassword,
  type AdminHttpApiDependencies,
} from '../../apps/api/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresOrganizationRepository,
  createPostgresOwnerCredentialRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createPostgresRateRepository,
  runMigrations,
  type BookingRequestRepository,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `admin_http_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;
const password = 'correct-horse-battery-staple';

function makeProperty(id: string, operationalNotes: string): PropertyConfigurationInput {
  return {
    id,
    name: 'Admin Integration Bungalow',
    summary: 'A property exercised through the owner HTTP boundary.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'EUR',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: [{ type: 'queen', quantity: 1 }],
    bathroomCount: 1,
    maximumGuests: 2,
    amenities: ['garden'],
    hostNotes: 'Guest-visible note.',
    operationalNotes,
  };
}

describe('owner admin HTTP against PostgreSQL persistence', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let organizationId: string;
  let otherOrganizationId: string;
  let propertyId: string;
  let ownerId: string;
  let ownerEmail: string;
  let passwordHash: string;
  let repository: BookingRequestRepository;
  let dependencies: AdminHttpApiDependencies;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
    passwordHash = await hashOwnerPassword(password);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationId = `org-a-${testId}`;
    otherOrganizationId = `org-b-${testId}`;
    propertyId = `property-${testId}`;
    ownerId = `owner-${testId}`;
    ownerEmail = `owner-${testId}@example.test`;
    const db = database as PostgresDatabasePort;
    const organizations = createPostgresOrganizationRepository(db);
    const properties = createPostgresPropertyRepository(db);
    const rates = createPostgresRateRepository(db);
    const availability = createPostgresAvailabilityRepository(db);
    const ownerCredentials = createPostgresOwnerCredentialRepository(db);
    repository = createPostgresBookingRequestRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    await organizations.create({ id: organizationId, name: 'Admin Tenant A' });
    await organizations.create({ id: otherOrganizationId, name: 'Admin Tenant B' });
    await properties.create(
      { organizationId: organizationId },
      makeProperty(propertyId, 'PRIVATE ADMIN POSTGRES MARKER'),
    );
    await properties.create(
      { organizationId: otherOrganizationId },
      makeProperty(`other-${propertyId}`, 'PRIVATE OTHER TENANT MARKER'),
    );
    await ownerCredentials.create({
      id: ownerId,
      email: ownerEmail,
      passwordHash,
      organizationId,
      role: 'owner',
    });
    await rates.saveRatePlan({ organizationId }, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12_500,
      cleaningFeeMinor: 3_500,
      minimumStayNights: 2,
    });
    dependencies = {
      credentials: ownerCredentials,
      properties,
      rates,
      availability,
      bookingRequests: repository,
      ical: {
        health: () => ({
          sourceId: 'airbnb-source',
          lastAttemptAt: '2026-08-01T00:00:00.000Z',
          lastSuccessAt: null,
          stale: true,
          error: { code: 'network_error', message: 'private provider details' },
        }),
      },
    };
  });

  afterEach(async () => {
    await pool?.query(`DELETE FROM ${table('organizations')} WHERE id = ANY($1::text[])`, [
      [organizationId, otherOrganizationId],
    ]);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
    await pool?.end();
  });

  async function authenticatedApi(email = ownerEmail): Promise<{
    readonly api: ReturnType<typeof createAdminHttpApi>;
    readonly cookies: string;
    readonly csrf: string;
  }> {
    const api = createAdminHttpApi(dependencies, {
      secureCookies: false,
      sessionStore: createPostgresAdminSessionStore(database as PostgresDatabasePort, {
        maxSessions: 10,
      }),
    });
    const loginPage = await api.handle({ method: 'GET', path: '/admin/login' });
    const loginSetCookie = loginPage.headers?.['set-cookie'];
    const loginCookies =
      typeof loginSetCookie === 'string' ? loginSetCookie : loginSetCookie?.join(', ');
    const anonymousCsrf = loginCookies?.match(/(?:^|,\s*)booking_engine_admin_csrf=([^;]+)/u)?.[1];
    if (anonymousCsrf === undefined) {
      throw new Error('integration login did not issue a CSRF cookie');
    }
    const login = await api.handle({
      method: 'POST',
      path: '/admin/login',
      headers: {
        cookie: `booking_engine_admin_csrf=${anonymousCsrf}`,
        'x-csrf-token': anonymousCsrf,
      },
      body: { email, password },
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers?.['set-cookie'];
    const cookiesHeader = typeof setCookie === 'string' ? setCookie : setCookie?.join(', ');
    const session = cookiesHeader?.match(/(?:^|,\s*)booking_engine_admin_session=([^;]+)/u)?.[1];
    const csrf = cookiesHeader?.match(/(?:^|,\s*)booking_engine_admin_csrf=([^;]+)/u)?.[1];
    if (session === undefined || csrf === undefined) {
      throw new Error('integration login did not issue session cookies');
    }
    return {
      api,
      cookies: `booking_engine_admin_session=${session}; booking_engine_admin_csrf=${csrf}`,
      csrf,
    };
  }

  it('updates private content, rates, manual blocks, health, and booking lifecycle in tenant scope', async () => {
    const db = database as PostgresDatabasePort;
    const properties = createPostgresPropertyRepository(db);
    const rates = createPostgresRateRepository(db);
    const { api, cookies, csrf } = await authenticatedApi();
    const headers = { cookie: cookies, 'x-csrf-token': csrf };

    const privateProperty = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers,
    });
    expect(privateProperty).toMatchObject({
      status: 200,
      body: { operationalNotes: 'PRIVATE ADMIN POSTGRES MARKER' },
    });
    const publicProperty = await properties.findPublicById({ organizationId }, propertyId);
    expect(publicProperty?.operationalNotes).toBe('public projection validation sentinel');

    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers,
        body: {
          id: propertyId,
          name: 'Updated Admin Bungalow',
          summary: 'Updated admin summary.',
          country: 'CA',
          timezone: 'America/Toronto',
          currency: 'EUR',
          propertyType: 'bungalow',
          bedroomCount: 1,
          bedConfiguration: [{ type: 'queen', quantity: 1 }],
          bathroomCount: 1,
          maximumGuests: 2,
          amenities: ['garden'],
          hostNotes: 'Updated public note.',
          operationalNotes: 'PRIVATE UPDATED ADMIN MARKER',
        },
      }),
    ).resolves.toMatchObject({ status: 200, body: { name: 'Updated Admin Bungalow' } });
    await expect(properties.findById({ organizationId }, propertyId)).resolves.toMatchObject({
      operationalNotes: 'PRIVATE UPDATED ADMIN MARKER',
    });

    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/rates`,
        headers,
        body: {
          currency: 'EUR',
          baseNightlyRateMinor: 13_000,
          cleaningFeeMinor: 3_500,
          minimumStayNights: 2,
          seasonalOverrides: [],
        },
      }),
    ).resolves.toMatchObject({ status: 200, body: { baseNightlyRateMinor: 13_000 } });
    await expect(rates.getRatePlan({ organizationId }, propertyId)).resolves.toMatchObject({
      baseNightlyRateMinor: 13_000,
    });

    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/manual-blocks`,
        headers,
        body: {
          id: `manual-${runId}`,
          arrival: '2026-09-01',
          departure: '2026-09-03',
          reason: 'Owner maintenance',
        },
      }),
    ).resolves.toMatchObject({ status: 201, body: { kind: 'manual' } });

    await expect(
      api.handle({
        method: 'GET',
        path: `/admin/properties/${propertyId}/ical/airbnb-source/health`,
        headers,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { sourceId: 'airbnb-source', stale: true, error: { code: 'network_error' } },
    });

    const quote = await rates.quote({ organizationId }, propertyId, {
      arrival: '2026-10-01',
      departure: '2026-10-03',
    });
    const input = {
      id: `request-${runId}`,
      arrival: '2026-10-01',
      departure: '2026-10-03',
      guestCount: 2,
      guestName: 'Guest Name',
      guestEmail: 'guest@example.test',
      message: 'Private request message',
      quote,
    } satisfies {
      readonly id: string;
      readonly arrival: string;
      readonly departure: string;
      readonly guestCount: number;
      readonly guestName: string;
      readonly guestEmail: string;
      readonly message: string;
      readonly quote: QuoteBreakdown;
    };
    await repository.submit({ organizationId }, propertyId, input, {
      idempotencyKey: `idempotency-${runId}`,
    });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/booking-requests/${input.id}/recheck`,
        headers,
      }),
    ).resolves.toMatchObject({ status: 200, body: { available: true } });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/booking-requests/${input.id}/approve`,
        headers,
      }),
    ).resolves.toMatchObject({ status: 200, body: { status: 'approved' } });
    await expect(repository.list({ organizationId }, propertyId)).resolves.toHaveLength(1);
    const requests = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}/booking-requests`,
      headers,
    });
    expect(requests).toMatchObject({
      status: 200,
      body: {
        requests: [
          {
            id: input.id,
            guestEmail: input.guestEmail,
            message: input.message,
          },
        ],
      },
    });
    expect(JSON.stringify(requests.body)).not.toContain('organizationId');
    const otherTenant = await api.handle({
      method: 'GET',
      path: `/admin/properties/other-${propertyId}`,
      headers,
    });
    expect(otherTenant).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
  });

  it('fails closed for a revoked membership, a viewer role, and a persisted wrong tenant', async () => {
    const db = database as PostgresDatabasePort;
    const credentials = createPostgresOwnerCredentialRepository(db);
    await credentials.create({
      id: `viewer-${ownerId}`,
      email: `viewer-${ownerId}@example.test`,
      passwordHash,
      organizationId,
      role: 'viewer',
    });
    await credentials.create({
      id: `other-${ownerId}`,
      email: `other-${ownerId}@example.test`,
      passwordHash,
      organizationId: otherOrganizationId,
      role: 'owner',
    });

    const viewer = await authenticatedApi(`viewer-${ownerId}@example.test`);
    await expect(
      viewer.api.handle({
        method: 'GET',
        path: `/admin/properties/${propertyId}`,
        headers: { cookie: viewer.cookies },
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });

    const other = await authenticatedApi(`other-${ownerId}@example.test`);
    await expect(
      other.api.handle({
        method: 'GET',
        path: `/admin/properties/${propertyId}`,
        headers: { cookie: other.cookies },
      }),
    ).resolves.toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });

    const owner = await authenticatedApi();
    const revoked = await credentials.revokeMembership(organizationId, ownerId);
    expect(revoked).toBe(true);
    await expect(
      owner.api.handle({
        method: 'GET',
        path: `/admin/properties/${propertyId}`,
        headers: { cookie: owner.cookies },
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: { code: 'invalid_session' } } });
  });

  it('revokes a persisted session through CSRF-protected logout', async () => {
    const { api, cookies, csrf } = await authenticatedApi();
    await expect(
      api.handle({
        method: 'POST',
        path: '/admin/logout',
        headers: { cookie: cookies, 'x-csrf-token': csrf },
      }),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      api.handle({
        method: 'GET',
        path: `/admin/properties/${propertyId}`,
        headers: { cookie: cookies },
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: { code: 'invalid_session' } } });
  });
});
