import { describe, expect, it, vi } from 'vitest';

import {
  createLotusBookingClientV1,
  LotusBookingApiErrorV1,
  PUBLIC_BOOKING_CONTRACT_MANIFEST_V1,
  PublicContractValidationErrorV1,
  PUBLIC_BOOKING_OPENAPI_V1,
  PUBLIC_BOOKING_PATHS_V1,
  type PublicPropertyV1,
} from '../src/index.js';

const property: PublicPropertyV1 = {
  id: 'sample-bungalow',
  name: 'Sample Bungalow',
  summary: 'A sunny bungalow near the coast.',
  country: 'CA',
  timezone: 'America/Toronto',
  currency: 'CAD',
  propertyType: 'bungalow',
  bedroomCount: 1,
  bedConfiguration: [{ type: 'queen', quantity: 1 }],
  bathroomCount: 1,
  maximumGuests: 2,
  amenities: ['private garden'],
  hostNotes: 'A sample property is available on arrival.',
};

describe('versioned public booking contract', () => {
  it('detects drift between the typed SDK route metadata and OpenAPI document', () => {
    const manifest = PUBLIC_BOOKING_CONTRACT_MANIFEST_V1;
    const operationEntries = Object.entries(manifest.operations);

    expect(operationEntries.map(([key]) => key)).toEqual([
      'property',
      'availability',
      'quote',
      'requestToBook',
    ]);
    for (const [, operation] of operationEntries) {
      const path = operation.path;
      const method = operation.method.toLowerCase();
      const documentOperation = (
        PUBLIC_BOOKING_OPENAPI_V1.paths as Record<
          string,
          Record<string, { readonly operationId?: string; readonly responses?: unknown }>
        >
      )[path]?.[method];
      expect(documentOperation).toBeDefined();
      expect(documentOperation?.operationId).toBe(operation.operationId);
      expect(documentOperation?.responses).toBeDefined();
    }

    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
      string,
      { readonly required?: readonly string[]; readonly properties?: Record<string, unknown> }
    >;
    for (const [schemaName, schemaManifest] of Object.entries(manifest.schemas)) {
      expect(Object.keys(schemas[schemaName]?.properties ?? {})).toEqual(schemaManifest.fields);
      expect(schemas[schemaName]?.required).toEqual(schemaManifest.required);
    }
  });

  it('publishes the four v1 REST boundaries without private or tenant fields', () => {
    expect(PUBLIC_BOOKING_OPENAPI_V1.openapi).toBe('3.0.3');
    expect(PUBLIC_BOOKING_OPENAPI_V1.info.version).toBe('1.0.0');
    expect(Object.keys(PUBLIC_BOOKING_OPENAPI_V1.paths)).toEqual([
      PUBLIC_BOOKING_PATHS_V1.property,
      PUBLIC_BOOKING_PATHS_V1.availability,
      PUBLIC_BOOKING_PATHS_V1.quote,
      PUBLIC_BOOKING_PATHS_V1.requestToBook,
    ]);

    const serialized = JSON.stringify(PUBLIC_BOOKING_OPENAPI_V1);
    expect(serialized).not.toContain('operationalNotes');
    expect(serialized).not.toContain('organizationId');
    expect(serialized).toContain('guestEmail');
    expect(serialized).toContain('totalMinor');

    const requestOperation = (
      PUBLIC_BOOKING_OPENAPI_V1.paths[PUBLIC_BOOKING_PATHS_V1.requestToBook] as {
        readonly post?: { readonly parameters?: readonly Record<string, unknown>[] };
      }
    ).post;
    expect(requestOperation?.parameters).toEqual(
      expect.arrayContaining([{ $ref: '#/components/parameters/IdempotencyKey' }]),
    );
    expect(PUBLIC_BOOKING_OPENAPI_V1.components.parameters['IdempotencyKey']).toEqual({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 1, maxLength: 128 },
    });
  });

  it('describes response and request schemas without cross-schema required fields', () => {
    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
      string,
      { readonly required?: readonly string[]; readonly properties?: Record<string, unknown> }
    >;
    const quoteSchema = schemas['PublicQuoteV1'];
    const requestSchema = schemas['PublicRequestToBookInputV1'];

    expect(quoteSchema?.required).toEqual(
      expect.arrayContaining([
        'propertyId',
        'arrival',
        'departure',
        'nights',
        'currency',
        'nightly',
        'totalMinor',
      ]),
    );
    expect(quoteSchema?.properties).not.toHaveProperty('available');
    expect(requestSchema?.required).toEqual(
      expect.arrayContaining(['arrival', 'departure', 'guestCount', 'guestName', 'guestEmail']),
    );
    expect(requestSchema?.properties).toHaveProperty('guestEmail');
  });

  it('derives typed requests from the v1 paths and decodes public responses', async () => {
    const fetcher = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'GET' && url.includes('/availability?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            propertyId: property.id,
            arrival: '2026-08-01',
            departure: '2026-08-03',
            nights: 2,
            available: true,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => property,
      };
    });

    const client = createLotusBookingClientV1({
      baseUrl: 'https://api.example.test/',
      fetch: fetcher,
    });

    await expect(client.getProperty(property.id)).resolves.toEqual(property);
    await expect(
      client.getAvailability(property.id, { arrival: '2026-08-01', departure: '2026-08-03' }),
    ).resolves.toMatchObject({ available: true, nights: 2 });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/v1/properties/sample-bungalow',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/v1/properties/sample-bungalow/availability?arrival=2026-08-01&departure=2026-08-03',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('validates bounded inputs before making a network request', async () => {
    const fetcher = vi.fn();
    const client = createLotusBookingClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    const inputWithUnknownField = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
      unexpected: 'private',
    } as never;
    await expect(
      client.requestToBook(property.id, inputWithUnknownField, {
        idempotencyKey: 'validation-key',
      }),
    ).rejects.toBeInstanceOf(PublicContractValidationErrorV1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed public response payloads and unknown error codes', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ...property, operationalNotes: 'private' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { code: 'private_internal_code', message: 'secret detail' } }),
      });
    const client = createLotusBookingClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    const malformedResponse = client.getProperty(property.id);
    await expect(malformedResponse).rejects.toMatchObject({
      code: 'internal_error',
      status: 200,
      message: 'The public API returned an invalid response.',
    });

    const unknownErrorResponse = client.getProperty(property.id);
    await expect(unknownErrorResponse).rejects.toBeInstanceOf(LotusBookingApiErrorV1);
    await expect(unknownErrorResponse).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
      message: 'The public API returned an invalid error response.',
    });
  });

  it('rejects public properties with enum values outside the v1 contract', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...property, propertyType: 'penthouse' }),
    }));
    const client = createLotusBookingClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      code: 'internal_error',
      status: 200,
      message: 'The public API returned an invalid response.',
    });
  });

  it('requires a bounded idempotency key transport header while keeping the body contract unchanged', async () => {
    const request = {
      id: 'request-001',
      propertyId: property.id,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      nights: 2,
      guestCount: 2,
      status: 'pending',
      quote: {
        propertyId: property.id,
        arrival: '2026-08-01',
        departure: '2026-08-03',
        nights: 2,
        currency: 'CAD',
        nightly: [
          { date: '2026-08-01', amountMinor: 12500, source: 'base' },
          { date: '2026-08-02', amountMinor: 12500, source: 'base' },
        ],
        nightlySubtotalMinor: 25000,
        cleaningFeeMinor: 3500,
        totalMinor: 28500,
        minimumStayNights: 2,
      },
      createdAt: '2026-07-12T12:00:00.000Z',
    };
    const fetcher = vi.fn(
      async (url: string, init: { headers: Readonly<Record<string, string>>; body?: string }) => ({
        ok: true,
        status: 201,
        json: async () => {
          void url;
          void init;
          return request;
        },
      }),
    );
    const client = createLotusBookingClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(
      client.requestToBook(
        property.id,
        {
          arrival: '2026-08-01',
          departure: '2026-08-03',
          guestCount: 2,
          guestName: 'Ada Lovelace',
          guestEmail: 'ada@example.test',
        },
        { idempotencyKey: 'sdk-retry-key' },
      ),
    ).resolves.toMatchObject({ id: 'request-001', status: 'pending' });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.example.test/v1/properties/${property.id}/request-to-book`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'sdk-retry-key' }),
      }),
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body ?? '{}')).not.toHaveProperty(
      'idempotencyKey',
    );
  });
});
