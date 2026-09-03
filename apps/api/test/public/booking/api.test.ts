import { describe, expect, it, vi } from 'vitest';

import {
  createPropertyConfiguration,
  type QuoteBreakdown,
  type PropertyConfiguration,
} from '@booking-engine/booking-core';
import type { PublicQuoteV1, PublicRequestToBookInputV1 } from '@booking-engine/sdk-typescript';
import type { BookingRequestRecord } from '@booking-engine/database-postgres';

import {
  PublicBookingApiError,
  createPublicBookingApi,
  createPublicBookingHttpApi,
  serializePublicBookingRequest,
  serializePublicQuote,
  type PublicBookingRequestRepository,
} from '../../../src/index.js';
import { sampleBungalowFixture } from '../../../../../packages/booking-core/test/property/fixtures.js';

const scope = { organizationId: 'org-a' };
const propertyId = sampleBungalowFixture.id;

function property(): PropertyConfiguration {
  const result = createPropertyConfiguration(sampleBungalowFixture);
  if (!result.ok) {
    throw new Error('fixture must be valid');
  }
  return result.value;
}

const quote: QuoteBreakdown = Object.freeze({
  arrival: '2026-08-01',
  departure: '2026-08-03',
  nights: 2,
  currency: 'EUR',
  nightly: Object.freeze([
    Object.freeze({ date: '2026-08-01', amountMinor: 12500, source: 'base' as const }),
    Object.freeze({ date: '2026-08-02', amountMinor: 12500, source: 'base' as const }),
  ]),
  nightlySubtotalMinor: 25000,
  cleaningFeeMinor: 3500,
  totalMinor: 28500,
  minimumStayNights: 2,
});

const requestInput: PublicRequestToBookInputV1 = {
  arrival: '2026-08-01',
  departure: '2026-08-03',
  guestCount: 2,
  guestName: 'Ada Lovelace',
  guestEmail: 'ada@example.test',
  message: 'A quiet weekend, please.',
};

function requestRecord(): BookingRequestRecord {
  return {
    id: 'request-001',
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
    idempotencyKey: 'private-idempotency-key',
    requestFingerprint: 'private-request-fingerprint',
    fingerprintVersion: 'sha256-v1',
    holdRecordId: 'private-hold-record',
    holdExpiresAt: '2026-07-12T12:15:00.000Z',
  };
}

function dependencies() {
  const findPublicById = vi.fn<() => Promise<PropertyConfiguration | null>>(async () => property());
  const bookingRequests: PublicBookingRequestRepository = {
    findByIdempotencyKey: vi.fn(async () => null),
    submit: vi.fn(async () => requestRecord()),
  };
  return {
    properties: { findPublicById },
    availability: { isAvailable: vi.fn(async () => true) },
    rates: { quote: vi.fn(async () => quote) },
    bookingRequests,
  };
}

describe('public booking API v1', () => {
  it('serializes property, availability, quote, and request data without private fields', async () => {
    const deps = dependencies();
    const api = createPublicBookingApi(deps);

    const publicProperty = await api.getProperty(scope, propertyId);
    expect(publicProperty).toMatchObject({ id: propertyId, name: sampleBungalowFixture.name });
    expect('operationalNotes' in publicProperty).toBe(false);

    await expect(
      api.getAvailability(scope, propertyId, {
        arrival: '2026-08-01',
        departure: '2026-08-03',
      }),
    ).resolves.toEqual({
      propertyId,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      nights: 2,
      available: true,
    });

    const publicQuote = await api.getQuote(scope, propertyId, {
      arrival: '2026-08-01',
      departure: '2026-08-03',
    });
    expect(publicQuote).toEqual({ propertyId, ...quote });
    expect('operationalNotes' in publicQuote).toBe(false);

    const publicRequest = await api.requestToBook(scope, propertyId, requestInput, 'initial-key');
    expect(publicRequest).toMatchObject({
      id: 'request-001',
      propertyId,
      status: 'pending',
      guestCount: 2,
      quote: { totalMinor: 28500 },
    });
    expect(JSON.stringify(publicRequest)).not.toContain('ada@example.test');
    expect(JSON.stringify(publicRequest)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(publicRequest)).not.toContain('operationalNotes');
    expect(deps.bookingRequests.submit).toHaveBeenCalledWith(
      scope,
      propertyId,
      expect.objectContaining({ guestEmail: 'ada@example.test', quote }),
      { idempotencyKey: expect.any(String), deferInventory: true },
    );
  });

  it('returns stable bounded validation errors and tenant-safe not-found errors', async () => {
    const deps = dependencies();
    deps.properties.findPublicById.mockResolvedValue(null);
    const api = createPublicBookingApi(deps);

    await expect(
      api.getQuote(scope, propertyId, { arrival: '2026-08-03', departure: '2026-08-03' }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(
      api.getProperty({ organizationId: 'other-tenant' }, propertyId),
    ).rejects.toMatchObject({
      status: 404,
      code: 'property_not_found',
      message: 'Property was not found.',
    });
  });

  it('keeps the REST adapter aligned with the OpenAPI boundary', async () => {
    const deps = dependencies();
    const http = createPublicBookingHttpApi(deps);

    const propertyResponse = await http.handle(scope, {
      method: 'GET',
      path: `/v1/properties/${propertyId}`,
    });
    expect(propertyResponse).toMatchObject({ status: 200, body: { id: propertyId } });

    const quoteResponse = await http.handle(scope, {
      method: 'POST',
      path: `/v1/properties/${propertyId}/quote`,
      body: { arrival: '2026-08-01', departure: '2026-08-03' },
    });
    expect(quoteResponse).toMatchObject({ status: 200, body: { propertyId, totalMinor: 28500 } });

    const invalidResponse = await http.handle(scope, {
      method: 'POST',
      path: `/v1/properties/${propertyId}/request-to-book`,
      body: { ...requestInput, guestEmail: 'not-an-email' },
    });
    expect(invalidResponse).toMatchObject({
      status: 400,
      body: { error: { code: 'validation_failed' } },
    });
  });

  it('uses explicit serializers that omit private request data', () => {
    const publicQuote: PublicQuoteV1 = serializePublicQuote(propertyId, quote);
    expect(publicQuote).toEqual({ propertyId, ...quote });

    const publicRequest = serializePublicBookingRequest(requestRecord());
    expect(Object.keys(publicRequest).sort()).toEqual([
      'arrival',
      'createdAt',
      'departure',
      'guestCount',
      'id',
      'nights',
      'propertyId',
      'quote',
      'status',
    ]);
  });

  it('replays the stored request before checking mutable property and rate state', async () => {
    const deps = dependencies();
    const replay = { ...requestRecord(), status: 'approved' as const };
    const findReplay = vi.fn(async () => replay);
    const submit = vi.fn(async () => {
      throw new Error('submit must not run for a replay');
    });
    deps.bookingRequests = { findByIdempotencyKey: findReplay, submit };
    deps.properties.findPublicById = vi.fn(async () => {
      throw new Error('property lookup must not run for a replay');
    });
    deps.rates.quote = vi.fn(async () => {
      throw new Error('rate lookup must not run for a replay');
    });
    const api = createPublicBookingApi(deps);

    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'replay-key'),
    ).resolves.toMatchObject({
      id: replay.id,
      status: 'approved',
      quote: replay.quote,
    });
    expect(findReplay).toHaveBeenCalledWith(
      scope,
      propertyId,
      {
        arrival: requestInput.arrival,
        departure: requestInput.departure,
        guestCount: requestInput.guestCount,
        guestName: requestInput.guestName,
        guestEmail: requestInput.guestEmail,
        message: requestInput.message,
      },
      'replay-key',
    );
    expect(deps.properties.findPublicById).not.toHaveBeenCalled();
    expect(deps.rates.quote).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('rechecks the stable replay after a submission race reports key reuse', async () => {
    const deps = dependencies();
    let lookupCount = 0;
    const findReplay = vi.fn(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? null : requestRecord();
    });
    const submit = vi.fn(async () => {
      throw { code: 'idempotency_key_reuse' };
    });
    deps.bookingRequests = { findByIdempotencyKey: findReplay, submit };
    const api = createPublicBookingApi(deps);

    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'raced-key'),
    ).resolves.toMatchObject({ id: 'request-001', status: 'pending' });
    expect(findReplay).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('maps persistence conflicts and property capacity failures to stable public errors', async () => {
    const deps = dependencies();
    deps.bookingRequests.submit = vi.fn(async () => {
      throw { code: 'availability_conflict' };
    });
    const api = createPublicBookingApi(deps);

    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'unavailable-key'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'stay_unavailable',
      message: 'The requested stay is not available.',
    });

    deps.bookingRequests.submit = vi.fn(async () => requestRecord());
    const limitedPropertyResult = createPropertyConfiguration({
      ...sampleBungalowFixture,
      maximumGuests: 1,
    });
    if (!limitedPropertyResult.ok) {
      throw new Error('fixture must be valid');
    }
    deps.properties.findPublicById = vi.fn(async () => limitedPropertyResult.value);
    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'capacity-key'),
    ).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      details: [{ field: 'guestCount', code: 'invalid_value' }],
    });
  });

  it('requires an explicit bounded idempotency key before creating a public request', async () => {
    const deps = dependencies();
    const api = createPublicBookingApi(deps);

    await expect(api.requestToBook(scope, propertyId, requestInput)).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      details: [{ field: 'idempotencyKey', code: 'missing_field' }],
    });
    expect(deps.bookingRequests.submit).not.toHaveBeenCalled();
  });

  it('uses the atomic submission boundary and forwards an idempotency key without exposing it', async () => {
    const deps = dependencies();
    const submit = vi.fn(async () => requestRecord());
    deps.bookingRequests = {
      findByIdempotencyKey: vi.fn(async () => null),
      submit,
    };
    const api = createPublicBookingApi(deps);

    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'retry-key-001'),
    ).resolves.toMatchObject({
      id: 'request-001',
      status: 'pending',
    });
    expect(submit).toHaveBeenCalledWith(
      scope,
      propertyId,
      expect.objectContaining({ guestEmail: requestInput.guestEmail }),
      { idempotencyKey: 'retry-key-001', deferInventory: true },
    );
    expect(
      JSON.stringify(await api.requestToBook(scope, propertyId, requestInput, 'retry-key-002')),
    ).not.toContain('retry-key-002');
  });

  it('fails closed when only the legacy non-atomic create boundary is composed', async () => {
    const deps = dependencies();
    const submit = deps.bookingRequests.submit;
    (deps.bookingRequests as unknown as { findByIdempotencyKey?: unknown }).findByIdempotencyKey =
      undefined;
    const api = createPublicBookingApi(deps);

    await expect(
      api.requestToBook(scope, propertyId, requestInput, 'legacy-key'),
    ).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
    });
    expect(submit).not.toHaveBeenCalled();
    expect(deps.availability.isAvailable).not.toHaveBeenCalled();
  });

  it('maps idempotency mismatch to the stable public conflict without leaking persistence details', async () => {
    const deps = dependencies();
    deps.bookingRequests = {
      findByIdempotencyKey: vi.fn(async () => null),
      submit: vi.fn(async () => {
        throw { code: 'idempotency_key_reuse', message: 'private fingerprint detail' };
      }),
    };
    const api = createPublicBookingApi(deps);

    await expect(api.requestToBook(scope, propertyId, requestInput, 'reused-key')).rejects.toEqual(
      new PublicBookingApiError(
        409,
        'request_conflict',
        'The booking request could not be accepted.',
      ),
    );
  });

  it('reads idempotency headers case-insensitively on the in-process HTTP boundary', async () => {
    const deps = dependencies();
    const submit = vi.fn(async () => requestRecord());
    deps.bookingRequests = {
      findByIdempotencyKey: vi.fn(async () => null),
      submit,
    };
    const http = createPublicBookingHttpApi(deps);

    await expect(
      http.handle(scope, {
        method: 'POST',
        path: `/v1/properties/${propertyId}/request-to-book`,
        headers: { 'Idempotency-Key': 'mixed-case-key' },
        body: requestInput,
      }),
    ).resolves.toMatchObject({ status: 201 });
    expect(submit).toHaveBeenCalledWith(scope, propertyId, expect.anything(), {
      idempotencyKey: 'mixed-case-key',
      deferInventory: true,
    });
  });

  it('returns stable route and method errors without exposing internal messages', async () => {
    const deps = dependencies();
    const http = createPublicBookingHttpApi(deps);

    await expect(
      http.handle(scope, { method: 'DELETE' as 'GET', path: `/v1/properties/${propertyId}` }),
    ).resolves.toEqual({
      status: 405,
      body: {
        error: { code: 'method_not_allowed', message: 'Method is not allowed for this route.' },
      },
    });
    await expect(
      http.handle(scope, { method: 'GET', path: '/v1/not-a-public-route' }),
    ).resolves.toEqual({
      status: 404,
      body: { error: { code: 'route_not_found', message: 'Public route was not found.' } },
    });
    await expect(
      http.handle(scope, {
        method: 'GET',
        path: `/v1/properties/${propertyId}/availability`,
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'validation_failed',
          details: [
            { field: 'arrival', code: 'missing_field' },
            { field: 'departure', code: 'missing_field' },
          ],
        },
      },
    });

    deps.rates.quote = vi.fn(async () => {
      throw Object.assign(new Error('PRIVATE internal database detail'), { code: 'unexpected' });
    });
    const api = createPublicBookingApi(deps);
    await expect(
      api.getQuote(scope, propertyId, {
        arrival: requestInput.arrival,
        departure: requestInput.departure,
      }),
    ).rejects.toEqual(
      new PublicBookingApiError(
        500,
        'internal_error',
        'The public API could not complete the request.',
      ),
    );
  });
});
