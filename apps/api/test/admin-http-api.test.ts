import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createRatePlanV1,
  createPropertyConfigurationV1,
  type PropertyConfigurationV1,
} from '@lotus-booking/booking-core';
import type {
  AvailabilityRecordV1,
  BookingRequestRecordV1,
  PostgresPropertyRepository,
} from '@lotus-booking/database-postgres';
import type { ICalSyncHealth } from '../src/jobs/ical-sync.js';

import {
  createAdminHttpApiV1,
  createAdminSessionStoreV1,
  createPublicBookingHttpServerV1,
  hashOwnerPasswordV1,
  type AdminCredentialRecordV1,
  type AdminHttpApiDependenciesV1,
} from '../src/index.js';
import { renderAdminPropertyPageV1 } from '../../../apps/admin/src/admin-property-page.js';
import { sampleBungalowFixture } from '../../../packages/booking-core/test/property-fixtures.js';

const propertyId = sampleBungalowFixture.id;
const organizationA = 'admin-org-a';
const password = 'correct-horse-battery-staple';

function property(): PropertyConfigurationV1 {
  const result = createPropertyConfigurationV1(sampleBungalowFixture);
  if (!result.ok) {
    throw new Error('fixture must be valid');
  }
  return result.value;
}

const ratePlanInput = {
  currency: 'EUR',
  baseNightlyRateMinor: 12_500,
  cleaningFeeMinor: 3_500,
  minimumStayNights: 2,
  seasonalOverrides: [],
};
const ratePlanResult = createRatePlanV1(ratePlanInput);
if (!ratePlanResult.ok) {
  throw new Error('rate fixture must be valid');
}
const ratePlan = ratePlanResult.value;

const manualBlock: AvailabilityRecordV1 = {
  id: 'owner-block-001',
  propertyId,
  kind: 'manual',
  status: 'active',
  arrival: '2026-09-01',
  departure: '2026-09-03',
  expiresAt: null,
  reason: 'Owner maintenance',
};

const request: BookingRequestRecordV1 = {
  id: 'request-owner-001',
  organizationId: organizationA,
  propertyId,
  arrival: '2026-10-01',
  departure: '2026-10-03',
  guestCount: 2,
  guestName: 'Guest Name',
  guestEmail: 'guest@example.test',
  message: 'Private guest message',
  status: 'pending',
  quote: {
    arrival: '2026-10-01',
    departure: '2026-10-03',
    nights: 2,
    currency: 'EUR',
    nightly: [
      { date: '2026-10-01', amountMinor: 12_500, source: 'base' },
      { date: '2026-10-02', amountMinor: 12_500, source: 'base' },
    ],
    nightlySubtotalMinor: 25_000,
    cleaningFeeMinor: 3_500,
    totalMinor: 28_500,
    minimumStayNights: 2,
  },
  createdAt: '2026-07-12T12:00:00.000Z',
};

const health: ICalSyncHealth = {
  sourceId: 'airbnb-source',
  lastAttemptAt: '2026-07-12T12:00:00.000Z',
  lastSuccessAt: null,
  stale: true,
  error: { code: 'network_error', message: 'PRIVATE upstream URL and stack detail' },
};

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (match?.[1] === undefined) {
    throw new Error(`missing ${name} cookie in ${setCookie ?? '<none>'}`);
  }
  return match[1];
}

function responseHeader(
  response: { readonly headers?: Readonly<Record<string, string | readonly string[]>> },
  name: string,
): string | null {
  const value = response.headers?.[name];
  return value === undefined ? null : typeof value === 'string' ? value : value.join(', ');
}

function credentials(
  passwordHash: string,
  role: AdminCredentialRecordV1['role'] = 'owner',
): AdminCredentialRecordV1 {
  return {
    id: 'owner-a',
    organizationId: organizationA,
    email: 'owner@example.test',
    role,
    passwordHash,
  };
}

function dependencies(
  passwordHash: string,
  role: AdminCredentialRecordV1['role'] = 'owner',
): AdminHttpApiDependenciesV1 {
  const currentProperty = property();
  return {
    credentials: {
      findByEmail: vi.fn(async (email: string) =>
        email === 'owner@example.test' ? credentials(passwordHash, role) : null,
      ),
    },
    properties: {
      findById: vi.fn(async (scope: { readonly organizationId: string }) =>
        scope.organizationId === organizationA ? currentProperty : null,
      ),
      update: vi.fn(async () => currentProperty),
    } as unknown as Pick<PostgresPropertyRepository, 'findById' | 'update'>,
    rates: {
      getRatePlan: vi.fn(async () => ratePlan),
      saveRatePlan: vi.fn(async () => ratePlan),
    },
    availability: {
      listManualBlocks: vi.fn(async () => [manualBlock]),
      createManualBlock: vi.fn(async () => manualBlock),
      releaseManualBlock: vi.fn(async () => true),
    },
    bookingRequests: {
      list: vi.fn(async () => [request]),
      find: vi.fn(async () => request),
      approve: vi.fn(async () => ({ ...request, status: 'approved' as const })),
      reject: vi.fn(async () => ({ ...request, status: 'rejected' as const })),
      recheckAvailability: vi.fn(async () => ({ request, available: true })),
    },
    ical: {
      health: vi.fn(() => health),
    },
  };
}

async function authenticatedApi(
  deps: AdminHttpApiDependenciesV1,
  existingApi?: ReturnType<typeof createAdminHttpApiV1>,
): Promise<{
  readonly api: ReturnType<typeof createAdminHttpApiV1>;
  readonly cookies: string;
  readonly csrf: string;
}> {
  const api = existingApi ?? createAdminHttpApiV1(deps, { secureCookies: false });
  const loginPage = await api.handle({ method: 'GET', path: '/admin/login' });
  const anonymousCsrf = cookieValue(responseHeader(loginPage, 'set-cookie'), 'lotus_admin_csrf');
  const login = await api.handle({
    method: 'POST',
    path: '/admin/login',
    headers: {
      cookie: `lotus_admin_csrf=${anonymousCsrf}`,
      'x-csrf-token': anonymousCsrf,
    },
    body: { email: 'owner@example.test', password },
  });
  expect(login.status).toBe(200);
  expect(JSON.stringify(login.body)).not.toContain(organizationA);
  const setCookie = responseHeader(login, 'set-cookie');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('Path=/');
  expect(setCookie).not.toContain('Domain=');
  const session = cookieValue(setCookie, 'lotus_admin_session');
  const csrf = cookieValue(setCookie, 'lotus_admin_csrf');
  return { api, cookies: `lotus_admin_session=${session}; lotus_admin_csrf=${csrf}`, csrf };
}

describe('owner admin authentication, authorization, and tenant-safe HTTP behavior', () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashOwnerPasswordV1(password);
  });

  it('rejects invalid credentials and invalid sessions without private data', async () => {
    const api = createAdminHttpApiV1(dependencies(passwordHash), { secureCookies: false });
    const loginPage = await api.handle({ method: 'GET', path: '/admin/login' });
    const csrf = cookieValue(responseHeader(loginPage, 'set-cookie'), 'lotus_admin_csrf');

    await expect(
      api.handle({
        method: 'POST',
        path: '/admin/login',
        headers: { cookie: `lotus_admin_csrf=${csrf}`, 'x-csrf-token': csrf },
        body: { email: 'owner@example.test', password: 'wrong-password' },
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: { code: 'invalid_credentials' } } });

    const invalidSession = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers: { cookie: 'lotus_admin_session=invalid-session' },
    });
    expect(invalidSession).toMatchObject({
      status: 401,
      body: { error: { code: 'invalid_session' } },
    });
    expect(JSON.stringify(invalidSession.body)).not.toContain('PRIVATE');
  });

  it('requires injected credentials and does not seed an account or fallback password', async () => {
    const base = dependencies(passwordHash);
    const findByEmail = vi.fn(async () => null);
    const deps: AdminHttpApiDependenciesV1 = {
      ...base,
      credentials: { findByEmail },
    };
    const api = createAdminHttpApiV1(deps, { secureCookies: false });
    const loginPage = await api.handle({ method: 'GET', path: '/admin/login' });
    const csrf = cookieValue(responseHeader(loginPage, 'set-cookie'), 'lotus_admin_csrf');

    await expect(
      api.handle({
        method: 'POST',
        path: '/admin/login',
        headers: { cookie: 'lotus_admin_csrf=' + csrf, 'x-csrf-token': csrf },
        body: { email: 'owner@example.test', password },
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: { code: 'invalid_credentials' } } });
    expect(findByEmail).toHaveBeenCalledWith('owner@example.test');
  });

  it('bounds and expires server-side sessions', () => {
    let now = 1_000;
    const store = createAdminSessionStoreV1({
      clock: () => now,
      ttlMs: 1_000,
      maxSessions: 1,
    });
    const user = {
      id: 'owner-a',
      organizationId: organizationA,
      email: 'owner@example.test',
      role: 'owner' as const,
    };
    const first = store.create(user);
    now += 1;
    const second = store.create(user);
    expect(store.get(first.token)).toBeNull();
    expect(store.get(second.token)).not.toBeNull();
    now += 1_000;
    expect(store.get(second.token)).toBeNull();
  });

  it('authenticates an owner and exposes private property content only through the owner boundary', async () => {
    const deps = dependencies(passwordHash);
    const { api, cookies, csrf } = await authenticatedApi(deps);

    const response = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers: { cookie: cookies },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: propertyId,
      operationalNotes: sampleBungalowFixture.operationalNotes,
    });
    expect(JSON.stringify(response.body)).not.toContain(organizationA);

    const publicResponse = await deps.properties.findById(
      { organizationId: organizationA },
      propertyId,
    );
    expect(publicResponse?.operationalNotes).toContain('PRIVATE');
    expect(csrf).toHaveLength(43);
  });

  it('requires a matching same-origin CSRF token for every state-changing admin route', async () => {
    const deps = dependencies(passwordHash);
    const { api, cookies, csrf } = await authenticatedApi(deps);
    const update = { ...sampleBungalowFixture, operationalNotes: 'Changed privately.' };

    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers: { cookie: cookies },
        body: update,
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'csrf_invalid' } } });
    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers: { cookie: cookies, 'x-csrf-token': 'wrong-token' },
        body: update,
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'csrf_invalid' } } });
    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers: {
          cookie: cookies,
          'x-csrf-token': csrf,
          origin: 'https://evil.example.test',
          host: 'admin.example.test',
        },
        body: update,
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'csrf_invalid' } } });
    expect(deps.properties.update).not.toHaveBeenCalled();

    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers: { cookie: cookies, 'x-csrf-token': csrf },
        body: update,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(deps.properties.update).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
      update,
    );
  });

  it('requires an origin or referer when an exact admin origin is configured', async () => {
    const deps = dependencies(passwordHash);
    const api = createAdminHttpApiV1(deps, {
      secureCookies: false,
      origin: 'https://admin.example.test',
    });
    const loginPage = await api.handle({ method: 'GET', path: '/admin/login' });
    const anonymousCsrf = cookieValue(responseHeader(loginPage, 'set-cookie'), 'lotus_admin_csrf');

    await expect(
      api.handle({
        method: 'POST',
        path: '/admin/login',
        headers: {
          cookie: 'lotus_admin_csrf=' + anonymousCsrf,
          'x-csrf-token': anonymousCsrf,
        },
        body: { email: 'owner@example.test', password },
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'csrf_invalid' } } });

    await expect(
      api.handle({
        method: 'POST',
        path: '/admin/login',
        headers: {
          cookie: 'lotus_admin_csrf=' + anonymousCsrf,
          'x-csrf-token': anonymousCsrf,
          origin: 'https://admin.example.test',
          host: 'admin.example.test',
        },
        body: { email: 'owner@example.test', password },
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('fails closed for a wrong role and a wrong tenant without disclosing existence', async () => {
    const viewerDependencies = dependencies(passwordHash, 'viewer');
    const viewerApi = createAdminHttpApiV1(viewerDependencies, {
      secureCookies: false,
    });
    const { cookies: viewerCookies } = await authenticatedApi(viewerDependencies, viewerApi);
    const viewerResponse = await viewerApi.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers: { cookie: viewerCookies },
    });
    expect(viewerResponse).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(JSON.stringify(viewerResponse.body)).not.toContain('PRIVATE');

    const deps = dependencies(passwordHash);
    const { api, cookies } = await authenticatedApi(deps);
    const tenantDeps = dependencies(passwordHash);
    const tenantFindById = vi.fn(async () => null);
    (tenantDeps.properties as unknown as { findById: typeof tenantFindById }).findById =
      tenantFindById;
    const { api: tenantApi, cookies: tenantCookies } = await authenticatedApi(tenantDeps);
    const wrongTenant = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers: { cookie: cookies },
    });
    const tenantNotFound = await tenantApi.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}`,
      headers: { cookie: tenantCookies },
    });
    expect(wrongTenant.status).toBe(200);
    expect(tenantNotFound).toMatchObject({
      status: 404,
      body: {
        error: { code: 'not_found', message: 'The requested admin resource was not found.' },
      },
    });
    expect(tenantFindById).toHaveBeenCalledWith({ organizationId: organizationA }, propertyId);
  });

  it('allows manager property access but limits booking decisions to owner and admin roles', async () => {
    const managerDependencies = dependencies(passwordHash, 'manager');
    const {
      api: managerApi,
      cookies: managerCookies,
      csrf: managerCsrf,
    } = await authenticatedApi(managerDependencies);
    const managerHeaders = {
      cookie: managerCookies,
      'x-csrf-token': managerCsrf,
    };
    await expect(
      managerApi.handle({
        method: 'GET',
        path: '/admin/properties/' + propertyId,
        headers: managerHeaders,
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      managerApi.handle({
        method: 'POST',
        path: '/admin/properties/' + propertyId + '/booking-requests/' + request.id + '/approve',
        headers: managerHeaders,
      }),
    ).resolves.toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(managerDependencies.bookingRequests.approve).not.toHaveBeenCalled();

    const adminDependencies = dependencies(passwordHash, 'admin');
    const {
      api: adminApi,
      cookies: adminCookies,
      csrf: adminCsrf,
    } = await authenticatedApi(adminDependencies);
    await expect(
      adminApi.handle({
        method: 'POST',
        path: '/admin/properties/' + propertyId + '/booking-requests/' + request.id + '/approve',
        headers: { cookie: adminCookies, 'x-csrf-token': adminCsrf },
      }),
    ).resolves.toMatchObject({ status: 200, body: { status: 'approved' } });
    expect(adminDependencies.bookingRequests.approve).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
      request.id,
    );
  });

  it('keeps content, rates, manual blocks, sync health, and booking decisions in one explicit scope', async () => {
    const deps = dependencies(passwordHash);
    const { api, cookies, csrf } = await authenticatedApi(deps);
    const headers = { cookie: cookies, 'x-csrf-token': csrf };

    await expect(
      api.handle({ method: 'GET', path: `/admin/properties/${propertyId}/rates`, headers }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        currency: ratePlan.currency,
        baseNightlyRateMinor: ratePlan.baseNightlyRateMinor,
        cleaningFeeMinor: ratePlan.cleaningFeeMinor,
        minimumStayNights: ratePlan.minimumStayNights,
        seasonalOverrides: [],
      },
    });
    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/rates`,
        headers,
        body: ratePlanInput,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        currency: ratePlan.currency,
        baseNightlyRateMinor: ratePlan.baseNightlyRateMinor,
        cleaningFeeMinor: ratePlan.cleaningFeeMinor,
        minimumStayNights: ratePlan.minimumStayNights,
        seasonalOverrides: [],
      },
    });
    await expect(
      api.handle({ method: 'GET', path: `/admin/properties/${propertyId}/manual-blocks`, headers }),
    ).resolves.toMatchObject({ status: 200, body: { blocks: [manualBlock] } });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/manual-blocks`,
        headers,
        body: {
          id: 'new-owner-block',
          arrival: '2026-11-01',
          departure: '2026-11-02',
          reason: 'Repair',
        },
      }),
    ).resolves.toMatchObject({ status: 201, body: manualBlock });
    await expect(
      api.handle({
        method: 'DELETE',
        path: `/admin/properties/${propertyId}/manual-blocks/${manualBlock.id}`,
        headers,
      }),
    ).resolves.toMatchObject({ status: 204 });

    const sync = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}/ical/${health.sourceId}/health`,
      headers,
    });
    expect(sync).toMatchObject({ status: 200, body: { sourceId: health.sourceId, stale: true } });
    expect(JSON.stringify(sync.body)).not.toContain('PRIVATE upstream URL');

    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/booking-requests/${request.id}/recheck`,
        headers,
      }),
    ).resolves.toMatchObject({ status: 200, body: { available: true } });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/booking-requests/${request.id}/approve`,
        headers,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { status: 'approved', guestEmail: request.guestEmail },
    });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/booking-requests/${request.id}/reject`,
        headers,
      }),
    ).resolves.toMatchObject({ status: 200, body: { status: 'rejected' } });

    expect(deps.rates.getRatePlan).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
    );
    expect(deps.rates.saveRatePlan).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
      ratePlan,
    );
    expect(deps.availability.listManualBlocks).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
    );
    expect(deps.bookingRequests.approve).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
      request.id,
    );
  });

  it('lists private booking requests only through the authenticated tenant scope', async () => {
    const deps = dependencies(passwordHash);
    const { api, cookies } = await authenticatedApi(deps);

    const response = await api.handle({
      method: 'GET',
      path: `/admin/properties/${propertyId}/booking-requests`,
      headers: { cookie: cookies },
    });

    expect(response).toMatchObject({
      status: 200,
      body: {
        requests: [
          {
            id: request.id,
            guestName: request.guestName,
            guestEmail: request.guestEmail,
            message: request.message,
          },
        ],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('organizationId');
    expect(deps.bookingRequests.list).toHaveBeenCalledWith(
      { organizationId: organizationA },
      propertyId,
    );
  });

  it('rejects oversized or malformed admin payloads before calling persistence', async () => {
    const deps = dependencies(passwordHash);
    const { api, cookies, csrf } = await authenticatedApi(deps);
    const headers = { cookie: cookies, 'x-csrf-token': csrf };

    const oversizedProperty = { ...sampleBungalowFixture, operationalNotes: 'x'.repeat(4_001) };
    await expect(
      api.handle({
        method: 'PUT',
        path: `/admin/properties/${propertyId}/content`,
        headers,
        body: oversizedProperty,
      }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'validation_failed' } } });
    await expect(
      api.handle({
        method: 'POST',
        path: `/admin/properties/${propertyId}/manual-blocks`,
        headers,
        body: {
          id: 'bounded-block',
          arrival: '2026-11-01',
          departure: '2026-11-02',
          reason: 'x'.repeat(501),
        },
      }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'validation_failed' } } });
    expect(deps.properties.update).not.toHaveBeenCalled();
    expect(deps.availability.createManualBlock).not.toHaveBeenCalled();
  });

  it('renders an escaped same-domain admin page with private content and CSRF forms', () => {
    const rendered = renderAdminPropertyPageV1({
      property: {
        id: propertyId,
        name: '<Owner property>',
        summary: 'Summary',
        hostNotes: 'Visible note',
        operationalNotes: 'PRIVATE <script>alert(1)</script>',
      },
      csrfToken: 'csrf-token',
    });

    expect(rendered).toContain('data-admin-property');
    expect(rendered).toContain('PRIVATE &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).not.toContain('<script>alert(1)</script>');
    expect(rendered).not.toContain('Â');
    expect(rendered).toContain('name="csrfToken" value="csrf-token"');
    expect(rendered).toContain('/admin/properties/');
    expect(rendered).toContain('/booking-requests');
  });
});

describe('owner admin over the real same-domain HTTP server', () => {
  let server: ReturnType<typeof createPublicBookingHttpServerV1> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('serves login, cookie session, private property content, and CSRF-protected updates', async () => {
    const passwordHash = await hashOwnerPasswordV1(password);
    const admin = dependencies(passwordHash);
    const publicProperty = property();
    server = createPublicBookingHttpServerV1(
      {
        properties: { findPublicById: vi.fn(async () => publicProperty) },
        availability: { isAvailable: vi.fn(async () => true) },
        rates: { quote: vi.fn(async () => request.quote) },
        bookingRequests: { submit: vi.fn(async () => request) },
      },
      {
        scope: { organizationId: organizationA },
        admin: { dependencies: admin, options: { secureCookies: false } },
      },
    );
    const address = await server.listen(0);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const loginPage = await fetch(`${baseUrl}/admin/login`);
    expect(loginPage.status).toBe(200);
    const anonymousCsrf = cookieValue(loginPage.headers.get('set-cookie'), 'lotus_admin_csrf');
    const login = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: {
        cookie: `lotus_admin_csrf=${anonymousCsrf}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrfToken: anonymousCsrf,
        email: 'owner@example.test',
        password,
      }),
    });
    expect(login.status).toBe(200);
    const session = cookieValue(login.headers.get('set-cookie'), 'lotus_admin_session');
    const csrf = cookieValue(login.headers.get('set-cookie'), 'lotus_admin_csrf');
    const cookies = `lotus_admin_session=${session}; lotus_admin_csrf=${csrf}`;

    const privateResponse = await fetch(`${baseUrl}/admin/properties/${propertyId}`, {
      headers: { cookie: cookies },
    });
    expect(privateResponse.status).toBe(200);
    expect(await privateResponse.json()).toMatchObject({
      operationalNotes: sampleBungalowFixture.operationalNotes,
    });

    const pageResponse = await fetch(`${baseUrl}/admin/properties/${propertyId}/page`, {
      headers: { cookie: cookies },
    });
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain('PRIVATE SAMPLE MARKER');

    const formResponse = await fetch(`${baseUrl}/admin/properties/${propertyId}/content`, {
      method: 'POST',
      headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: csrf,
        name: 'Updated through owner form',
        summary: 'Updated form summary',
        operationalNotes: 'Updated private form note',
      }),
    });
    expect(formResponse.status).toBe(200);
    const updateCallCount = (
      admin.properties.update as unknown as {
        readonly mock: { readonly calls: readonly unknown[][] };
      }
    ).mock.calls.length;

    const csrfResponse = await fetch(`${baseUrl}/admin/properties/${propertyId}/content`, {
      method: 'PUT',
      headers: { cookie: cookies, 'content-type': 'application/json' },
      body: JSON.stringify({ ...sampleBungalowFixture, operationalNotes: 'should-not-write' }),
    });
    expect(csrfResponse.status).toBe(403);
    expect(
      (
        admin.properties.update as unknown as {
          readonly mock: { readonly calls: readonly unknown[][] };
        }
      ).mock.calls.length,
    ).toBe(updateCallCount);
  });
});
