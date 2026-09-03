import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPropertyConfiguration,
  type PropertyConfiguration,
  type QuoteBreakdown,
} from '@booking-engine/booking-core';
import type { BookingRequestRecord } from '@booking-engine/database-postgres';
import type { PublicRequestToBookInputV1 } from '@booking-engine/sdk-typescript';

import { createApiHttpServer, type PublicBookingRequestRepository } from '../../../src/index.js';
import { sampleBungalowFixture } from '../../../../../packages/booking-core/test/property/fixtures.js';

const scope = { organizationId: 'org-http-test' };
const propertyId = sampleBungalowFixture.id;
const requestInput: PublicRequestToBookInputV1 = {
  arrival: '2026-08-01',
  departure: '2026-08-03',
  guestCount: 2,
  guestName: 'Ada Lovelace',
  guestEmail: 'ada@example.test',
  message: 'Please confirm availability.',
};
const quote: QuoteBreakdown = {
  arrival: '2026-08-01',
  departure: '2026-08-03',
  nights: 2,
  currency: 'EUR',
  nightly: [
    { date: '2026-08-01', amountMinor: 12500, source: 'base' },
    { date: '2026-08-02', amountMinor: 12500, source: 'base' },
  ],
  nightlySubtotalMinor: 25000,
  cleaningFeeMinor: 3500,
  totalMinor: 28500,
  minimumStayNights: 2,
};

function property(): PropertyConfiguration {
  const result = createPropertyConfiguration(sampleBungalowFixture);
  if (!result.ok) {
    throw new Error('fixture must be valid');
  }
  return result.value;
}

function requestRecordForHttp(): BookingRequestRecord {
  return {
    id: 'request-http-001',
    organizationId: scope.organizationId,
    propertyId,
    arrival: requestInput.arrival,
    departure: requestInput.departure,
    guestCount: requestInput.guestCount,
    guestName: requestInput.guestName,
    guestEmail: requestInput.guestEmail,
    message: requestInput.message ?? null,
    status: 'pending',
    quote,
    createdAt: '2026-07-12T12:00:00.000Z',
    fingerprintVersion: 'sha256-v1',
  };
}

function dependencies() {
  const publicProperty = property();
  const bookingRequests: PublicBookingRequestRepository = {
    findByIdempotencyKey: vi.fn(async () => null),
    submit: vi.fn(
      async (_scope, requestedPropertyId, input): Promise<BookingRequestRecord> => ({
        ...input,
        organizationId: scope.organizationId,
        propertyId: requestedPropertyId,
        status: 'pending',
        createdAt: '2026-07-12T12:00:00.000Z',
        fingerprintVersion: 'sha256-v1',
      }),
    ),
  };

  return {
    properties: { findPublicById: vi.fn(async () => publicProperty) },
    availability: { isAvailable: vi.fn(async () => true) },
    rates: { quote: vi.fn(async () => quote) },
    bookingRequests,
  };
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe('public booking v1 real HTTP server', () => {
  let server: ReturnType<typeof createApiHttpServer> | undefined;
  let baseUrl: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    baseUrl = undefined;
  });

  it('serves OpenAPI and every v1 route through a bound ephemeral server', async () => {
    server = createApiHttpServer(dependencies(), { scope });
    const address = await server.listen(0);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const openApiResponse = await fetch(`${baseUrl}/openapi/v1.json`);
    expect(openApiResponse.status).toBe(200);
    const openApi = (await json(openApiResponse)) as {
      readonly openapi: string;
      readonly paths: Record<string, unknown>;
    };
    expect(openApi.openapi).toBe('3.0.3');
    expect(Object.keys(openApi.paths)).toEqual([
      '/v1/properties/{propertyId}',
      '/v1/properties/{propertyId}/availability',
      '/v1/properties/{propertyId}/quote',
      '/v1/properties/{propertyId}/request-to-book',
    ]);

    const propertyResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}`);
    expect(propertyResponse.status).toBe(200);
    const propertyBody = await json(propertyResponse);
    expect(propertyBody).toMatchObject({ id: propertyId });
    expect(JSON.stringify(propertyBody)).not.toContain('PRIVATE SAMPLE MARKER');
    expect(JSON.stringify(propertyBody)).not.toContain('operationalNotes');

    const availabilityResponse = await fetch(
      `${baseUrl}/v1/properties/${propertyId}/availability?arrival=2026-08-01&departure=2026-08-03`,
    );
    expect(availabilityResponse.status).toBe(200);
    expect(await json(availabilityResponse)).toMatchObject({
      propertyId,
      nights: 2,
      available: true,
    });

    const quoteResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arrival: '2026-08-01', departure: '2026-08-03' }),
    });
    expect(quoteResponse.status).toBe(200);
    expect(await json(quoteResponse)).toMatchObject({ propertyId, totalMinor: 28500 });

    const requestResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-initial-key' },
      body: JSON.stringify(requestInput),
    });
    expect(requestResponse.status).toBe(201);
    const requestBody = await json(requestResponse);
    expect(requestBody).toMatchObject({ propertyId, status: 'pending', guestCount: 2 });
    expect(JSON.stringify(requestBody)).not.toContain('ada@example.test');
    expect(JSON.stringify(requestBody)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(requestBody)).not.toContain('operationalNotes');
  });

  it('serves a bounded health probe without entering a tenant-scoped public route', async () => {
    server = createApiHttpServer(dependencies(), { scope });
    const address = await server.listen(0);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await json(response)).toEqual({ status: 'ok' });
  });

  it('keeps invalid, method, not-found, and private-data behavior on the real transport', async () => {
    server = createApiHttpServer(dependencies(), { scope });
    const address = await server.listen(0);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const invalidResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arrival: 'not-a-date', departure: '2026-08-03' }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await json(invalidResponse)).toMatchObject({
      error: { code: 'validation_failed' },
    });

    const methodResponse = await fetch(`${baseUrl}/v1/properties/${propertyId}`, {
      method: 'DELETE',
    });
    expect(methodResponse.status).toBe(405);
    expect(await json(methodResponse)).toEqual({
      error: { code: 'method_not_allowed', message: 'Method is not allowed for this route.' },
    });

    const notFoundResponse = await fetch(`${baseUrl}/v1/private/internal`);
    expect(notFoundResponse.status).toBe(404);
    const notFoundBody = await json(notFoundResponse);
    expect(notFoundBody).toEqual({
      error: { code: 'route_not_found', message: 'Public route was not found.' },
    });
    expect(JSON.stringify(notFoundBody)).not.toContain('PRIVATE');
  });

  it('passes the idempotency key and pending-only mode to the request boundary', async () => {
    const deps = dependencies();
    const submit = vi.fn(async () => requestRecordForHttp());
    deps.bookingRequests = {
      findByIdempotencyKey: vi.fn(async () => null),
      submit,
    };
    server = createApiHttpServer(deps, { scope });
    const address = await server.listen(0);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/v1/properties/${propertyId}/request-to-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-retry-key' },
      body: JSON.stringify(requestInput),
    });
    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith(
      scope,
      propertyId,
      expect.objectContaining({ guestEmail: 'ada@example.test' }),
      { idempotencyKey: 'http-retry-key', deferInventory: true },
    );
    expect(JSON.stringify(await response.json())).not.toContain('http-retry-key');
  });
});
