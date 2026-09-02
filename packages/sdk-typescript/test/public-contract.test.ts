import { describe, expect, it, vi } from 'vitest';

import {
  createBookingEngineClientV1,
  BookingEngineApiErrorV1,
  PUBLIC_BOOKING_CONTRACT_MANIFEST_V1,
  PublicContractValidationErrorV1,
  PUBLIC_BOOKING_OPENAPI_V1,
  PUBLIC_BOOKING_PATHS_V1,
  type BookingEngineClientV1,
  PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
  type PublicPropertyV1,
  type PublicRequestToBookInputV1,
  type PublicRequestToBookV1,
  type PublicValidationIssueV1,
  validatePublicAvailabilityRequestV1,
  validatePublicIdempotencyKeyV1,
  validatePublicPropertyIdV1,
  validatePublicQuoteRequestV1,
  validatePublicRequestToBookV1,
  validatePublicStayV1,
} from '../src/index.js';

// @ts-expect-error The compatibility input alias is not public.
import type { PublicBookingRequestInputV1 } from '../src/index.js';
// @ts-expect-error The compatibility response alias is not public.
import type { PublicBookingRequestV1 } from '../src/index.js';

const removedCompatibilityAliasTypeCheck:
  | PublicBookingRequestInputV1
  | PublicBookingRequestV1
  | undefined = undefined;
void removedCompatibilityAliasTypeCheck;

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

const requestedStay = { arrival: '2026-08-01', departure: '2026-08-03' } as const;

const quoteResponse = {
  propertyId: property.id,
  ...requestedStay,
  nights: 2,
  currency: 'CAD',
  nightly: [
    { date: '2026-08-01', amountMinor: 12_500, source: 'base' },
    { date: '2026-08-02', amountMinor: 12_500, source: 'base' },
  ],
  nightlySubtotalMinor: 25_000,
  cleaningFeeMinor: 3_500,
  totalMinor: 28_500,
  minimumStayNights: 2,
} as const;

const requestResponse = {
  id: 'request-001',
  propertyId: property.id,
  ...requestedStay,
  nights: 2,
  guestCount: 2,
  status: 'pending',
  quote: quoteResponse,
  createdAt: '2026-07-12T12:00:00.000Z',
} as const satisfies PublicRequestToBookV1;

const operationErrorCases = [
  { operation: 'property', status: 400, codes: ['validation_failed'] },
  { operation: 'property', status: 404, codes: ['property_not_found'] },
  { operation: 'property', status: 500, codes: ['internal_error'] },
  { operation: 'availability', status: 400, codes: ['validation_failed'] },
  { operation: 'availability', status: 404, codes: ['property_not_found'] },
  { operation: 'availability', status: 500, codes: ['internal_error'] },
  { operation: 'quote', status: 400, codes: ['validation_failed'] },
  {
    operation: 'quote',
    status: 404,
    codes: ['property_not_found', 'quote_unavailable'],
  },
  { operation: 'quote', status: 500, codes: ['internal_error'] },
  { operation: 'requestToBook', status: 400, codes: ['validation_failed'] },
  {
    operation: 'requestToBook',
    status: 404,
    codes: ['property_not_found', 'quote_unavailable'],
  },
  {
    operation: 'requestToBook',
    status: 409,
    codes: ['stay_unavailable', 'request_conflict'],
  },
  { operation: 'requestToBook', status: 500, codes: ['internal_error'] },
] as const;

type OperationUnderTest = (typeof operationErrorCases)[number]['operation'];

function requestForOperation(
  client: BookingEngineClientV1,
  operation: OperationUnderTest,
): Promise<unknown> {
  switch (operation) {
    case 'property':
      return client.getProperty(property.id);
    case 'availability':
      return client.getAvailability(property.id, requestedStay);
    case 'quote':
      return client.getQuote(property.id, requestedStay);
    case 'requestToBook':
      return client.requestToBook(
        property.id,
        {
          ...requestedStay,
          guestCount: 2,
          guestName: 'Ada Lovelace',
          guestEmail: 'ada@example.test',
        },
        { idempotencyKey: 'operation-error-code-test' },
      );
  }
}

function expectDeeplyFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const nestedValue of Object.values(value)) {
    expectDeeplyFrozen(nestedValue);
  }
}

describe('versioned public booking contract', () => {
  it('detects drift between the typed SDK route metadata and OpenAPI document', () => {
    const manifest = PUBLIC_BOOKING_CONTRACT_MANIFEST_V1;
    const operationEntries = Object.entries(manifest.operations);
    const documentedPaths = PUBLIC_BOOKING_OPENAPI_V1.paths as Record<
      string,
      Record<
        string,
        {
          readonly operationId?: string;
          readonly responses?: Readonly<Record<string, { readonly description?: string }>>;
        }
      >
    >;

    expect(operationEntries.map(([key]) => key)).toEqual([
      'property',
      'availability',
      'quote',
      'requestToBook',
    ]);
    for (const [, operation] of operationEntries) {
      const path = operation.path;
      const method = operation.method.toLowerCase();
      const documentOperation = documentedPaths[path]?.[method];
      const documentedResponses: Readonly<Record<string, { readonly description?: string }>> =
        documentOperation?.responses ?? {};
      expect(documentOperation).toBeDefined();
      expect(documentOperation?.operationId).toBe(operation.operationId);
      expect(Object.keys(documentedResponses).map(Number)).toEqual(operation.statuses);
      expect(operation.statuses).toContain(500);
      expect(documentedResponses['500']?.description).toContain('internal_error');
    }
    expect(
      documentedPaths[manifest.operations.property.path]?.['get']?.responses?.['400']?.description,
    ).toContain('validation_failed');
    expect(
      documentedPaths[manifest.operations.availability.path]?.['get']?.responses?.['404']
        ?.description,
    ).toContain('property_not_found');
    expect(
      documentedPaths[manifest.operations.requestToBook.path]?.['post']?.responses?.['404']
        ?.description,
    ).toContain('property_not_found');
    expect(
      documentedPaths[manifest.operations.requestToBook.path]?.['post']?.responses?.['404']
        ?.description,
    ).toContain('quote_unavailable');

    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
      string,
      {
        readonly required?: readonly string[];
        readonly properties?: Record<string, unknown>;
      }
    >;
    for (const [schemaName, schemaManifest] of Object.entries(manifest.schemas)) {
      expect(Object.keys(schemas[schemaName]?.properties ?? {})).toEqual(schemaManifest.fields);
      expect(schemas[schemaName]?.required).toEqual(schemaManifest.required);
    }

    const propertySchema = schemas['PublicPropertyV1'];
    for (const [field, bounds] of Object.entries(manifest.schemas.PublicPropertyV1.bounds)) {
      expect(propertySchema?.properties?.[field]).toMatchObject(bounds);
    }
    const validationIssueSchema = schemas['PublicValidationIssueV1'];
    for (const [field, bounds] of Object.entries(manifest.schemas.PublicValidationIssueV1.bounds)) {
      expect(validationIssueSchema?.properties?.[field]).toMatchObject(bounds);
    }
  });

  it('binds each operation error status to the exact manifest and OpenAPI codes', () => {
    type DocumentedErrorResponse = {
      readonly content?: Readonly<
        Record<
          string,
          {
            readonly schema?: {
              readonly properties?: {
                readonly error?: {
                  readonly properties?: {
                    readonly code?: { readonly enum?: readonly string[] };
                  };
                };
              };
            };
          }
        >
      >;
    };

    const manifest = PUBLIC_BOOKING_CONTRACT_MANIFEST_V1;
    const documentedPaths = PUBLIC_BOOKING_OPENAPI_V1.paths as Record<
      string,
      Record<
        string,
        {
          readonly responses?: Readonly<Record<string, DocumentedErrorResponse>>;
        }
      >
    >;
    const actualErrorCases: {
      readonly operation: string;
      readonly status: number;
      readonly codes: readonly string[];
    }[] = [];

    for (const [operation, metadata] of Object.entries(manifest.operations)) {
      expect(Object.isFrozen(metadata.errorCodesByStatus)).toBe(true);
      expect(Object.keys(metadata.errorCodesByStatus).map(Number)).toEqual(
        metadata.statuses.filter((status) => status >= 400),
      );
      for (const [status, codes] of Object.entries(metadata.errorCodesByStatus)) {
        expect(Object.isFrozen(codes)).toBe(true);
        actualErrorCases.push({ operation, status: Number(status), codes });
      }
    }
    expect(actualErrorCases).toEqual(operationErrorCases);

    for (const { operation, status, codes } of operationErrorCases) {
      const metadata = manifest.operations[operation];
      const manifestCodes = Object.entries(metadata.errorCodesByStatus).find(
        ([documentedStatus]) => Number(documentedStatus) === status,
      )?.[1];
      const response =
        documentedPaths[metadata.path]?.[metadata.method.toLowerCase()]?.responses?.[
          String(status)
        ];
      const openApiCodes =
        response?.content?.['application/json']?.schema?.properties?.error?.properties?.code?.enum;

      expect(manifestCodes).toEqual(codes);
      expect(openApiCodes).toBe(manifestCodes);
      expect(openApiCodes).toEqual(codes);
      expect(Object.isFrozen(openApiCodes)).toBe(true);
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
        readonly post?: {
          readonly description?: string;
          readonly parameters?: readonly Record<string, unknown>[];
          readonly responses?: Readonly<Record<string, { readonly description?: string }>>;
        };
      }
    ).post;
    expect(requestOperation?.parameters).toEqual(
      expect.arrayContaining([{ $ref: '#/components/parameters/IdempotencyKey' }]),
    );
    expect(PUBLIC_BOOKING_OPENAPI_V1.components.parameters['IdempotencyKey']).toEqual({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[!-~]+(?![\\s\\S])',
      },
    });
    expect(requestOperation?.description).toContain('current lifecycle status');
    expect(requestOperation?.responses?.['201']?.description).toContain(
      'current state of an existing request',
    );
  });

  it('keeps Unicode body-text constraints separate from portable header constraints', () => {
    type TextSchemaV1 = {
      readonly type?: string;
      readonly format?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
    };
    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
      string,
      { readonly properties?: Readonly<Record<string, TextSchemaV1>> }
    >;
    const requestSchema = schemas['PublicRequestToBookInputV1'];
    const guestNameSchema = requestSchema?.properties?.['guestName'];
    const messageSchema = requestSchema?.properties?.['message'];
    const guestEmailSchema = requestSchema?.properties?.['guestEmail'];
    const idempotencyParameter = PUBLIC_BOOKING_OPENAPI_V1.components.parameters[
      'IdempotencyKey'
    ] as {
      readonly schema?: TextSchemaV1;
    };
    const idempotencyKeySchema = idempotencyParameter.schema;
    const bodyTextPattern =
      '^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?=[\\s\\S]*\\S)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
    const idempotencyKeyPattern = '^[!-~]+(?![\\s\\S])';

    expect(guestNameSchema).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 120,
      pattern: bodyTextPattern,
    });
    expect(messageSchema).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 2_000,
      pattern: bodyTextPattern,
    });
    expect(guestEmailSchema).toEqual({
      type: 'string',
      format: 'email',
      minLength: 1,
      maxLength: 254,
      pattern: bodyTextPattern,
    });
    expect(idempotencyKeySchema).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: idempotencyKeyPattern,
    });
    const bodyTextRegularExpression = new RegExp(bodyTextPattern, 'u');
    const loneHighSurrogate = '\uD83C';
    const loneLowSurrogate = '\uDFE0';
    const astralCharacter = `${loneHighSurrogate}${loneLowSurrogate}`;
    expect(bodyTextRegularExpression.test('')).toBe(false);
    expect(bodyTextRegularExpression.test('Ada\u0001')).toBe(false);
    expect(bodyTextRegularExpression.test(loneHighSurrogate)).toBe(false);
    expect(bodyTextRegularExpression.test(loneLowSurrogate)).toBe(false);
    expect(bodyTextRegularExpression.test(astralCharacter)).toBe(true);
    expect(Array.from(astralCharacter)).toEqual([astralCharacter]);
    const idempotencyKeyRegularExpression = new RegExp(idempotencyKeySchema?.pattern ?? '', 'u');
    expect(idempotencyKeyRegularExpression.test('!portable-key~')).toBe(true);
    expect(idempotencyKeyRegularExpression.test('key with space')).toBe(false);
    expect(idempotencyKeyRegularExpression.test('key\u0009with-control')).toBe(false);
    expect(idempotencyKeyRegularExpression.test('caf\u00e9')).toBe(false);
    expect(idempotencyKeyRegularExpression.test('\u{1f3e0}')).toBe(false);

    const validRequest = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };
    for (const [field, value] of [
      ['guestName', loneHighSurrogate],
      ['guestName', loneLowSurrogate],
      ['guestEmail', `ada${loneHighSurrogate}@example.test`],
      ['guestEmail', `ada${loneLowSurrogate}@example.test`],
      ['message', loneHighSurrogate],
      ['message', loneLowSurrogate],
    ] as const) {
      expect(validatePublicRequestToBookV1({ ...validRequest, [field]: value })).toMatchObject({
        ok: false,
        errors: [{ field, code: 'invalid_string' }],
      });
    }
    expect(validatePublicRequestToBookV1({ ...validRequest, message: '' })).toMatchObject({
      ok: false,
      errors: [{ field: 'message', code: 'empty_string' }],
    });
    expect(
      validatePublicRequestToBookV1({ ...validRequest, guestName: 'Ada\u0001Lovelace' }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'guestName', code: 'invalid_string' }],
    });
    expect(validatePublicIdempotencyKeyV1('   ')).toMatchObject({
      ok: false,
      errors: [{ field: 'idempotencyKey', code: 'invalid_string' }],
    });
  });

  it('counts astral request text by code point and bounds idempotency keys as ASCII', () => {
    type TextSchemaV1 = {
      readonly maxLength?: number;
    };
    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
      string,
      { readonly properties?: Readonly<Record<string, TextSchemaV1>> }
    >;
    const requestProperties = schemas['PublicRequestToBookInputV1']?.properties;
    const idempotencyParameter = PUBLIC_BOOKING_OPENAPI_V1.components.parameters[
      'IdempotencyKey'
    ] as {
      readonly schema?: TextSchemaV1;
    };
    const guestNameMaximum = requestProperties?.['guestName']?.maxLength;
    const messageMaximum = requestProperties?.['message']?.maxLength;
    const idempotencyKeyMaximum = idempotencyParameter.schema?.maxLength;
    expect([guestNameMaximum, messageMaximum, idempotencyKeyMaximum]).toEqual([120, 2_000, 128]);
    if (
      guestNameMaximum === undefined ||
      messageMaximum === undefined ||
      idempotencyKeyMaximum === undefined
    ) {
      throw new TypeError('OpenAPI text limits must be defined.');
    }

    const astralCharacter = '\u{1f3e0}';
    expect(Array.from(astralCharacter)).toEqual([astralCharacter]);
    const guestNameAtMaximum = astralCharacter.repeat(guestNameMaximum);
    const messageAtMaximum = astralCharacter.repeat(messageMaximum);
    const idempotencyKeyAtMaximum = '~'.repeat(idempotencyKeyMaximum);
    expect(guestNameAtMaximum.length).toBe(guestNameMaximum * 2);
    expect(messageAtMaximum.length).toBe(messageMaximum * 2);
    expect(idempotencyKeyAtMaximum.length).toBe(idempotencyKeyMaximum);

    const validRequest = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };
    expect(
      validatePublicRequestToBookV1({ ...validRequest, guestName: guestNameAtMaximum }),
    ).toMatchObject({ ok: true, value: { guestName: guestNameAtMaximum } });
    expect(
      validatePublicRequestToBookV1({
        ...validRequest,
        guestName: guestNameAtMaximum + astralCharacter,
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'guestName', code: 'string_too_long' }],
    });
    expect(
      validatePublicRequestToBookV1({ ...validRequest, message: messageAtMaximum }),
    ).toMatchObject({ ok: true, value: { message: messageAtMaximum } });
    expect(
      validatePublicRequestToBookV1({
        ...validRequest,
        message: messageAtMaximum + astralCharacter,
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'message', code: 'string_too_long' }],
    });
    expect(validatePublicIdempotencyKeyV1(idempotencyKeyAtMaximum)).toEqual({
      ok: true,
      value: idempotencyKeyAtMaximum,
    });
    expect(validatePublicIdempotencyKeyV1(idempotencyKeyAtMaximum + '~')).toMatchObject({
      ok: false,
      errors: [{ field: 'idempotencyKey', code: 'invalid_string' }],
    });
    for (const idempotencyKey of ['caf\u00e9', '\u{1f3e0}']) {
      expect(validatePublicIdempotencyKeyV1(idempotencyKey)).toMatchObject({
        ok: false,
        errors: [{ field: 'idempotencyKey', code: 'invalid_string' }],
      });
    }
  });

  it('decodes the documented property and scoped error behavior', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details: [
              {
                field: 'propertyId',
                code: 'invalid_identifier',
                message: 'propertyId must be a valid public identifier.',
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            code: 'property_not_found',
            message: 'Property not found.',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: {
            code: 'quote_unavailable',
            message: 'A quote is unavailable for this stay.',
          },
        }),
      });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });
    const stay = { arrival: '2026-08-01', departure: '2026-08-03' };

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      status: 400,
      code: 'validation_failed',
      details: [{ field: 'propertyId', code: 'invalid_identifier' }],
    });
    await expect(client.getAvailability(property.id, stay)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      status: 404,
      code: 'property_not_found',
    });
    await expect(
      client.requestToBook(
        property.id,
        {
          ...stay,
          guestCount: 2,
          guestName: 'Ada Lovelace',
          guestEmail: 'ada@example.test',
        },
        { idempotencyKey: 'documented-404-key' },
      ),
    ).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      status: 404,
      code: 'quote_unavailable',
    });
  });

  it.each(
    operationErrorCases.flatMap(({ operation, status, codes }) =>
      codes.map((code) => ({ operation, status, code })),
    ),
  )(
    'decodes the documented $operation $status $code error tuple',
    async ({ operation, status, code }) => {
      const client = createBookingEngineClientV1({
        baseUrl: 'https://api.example.test',
        fetch: async () => ({
          ok: false,
          status,
          json: async () => ({
            error: {
              code,
              message: 'Documented public error.',
            },
          }),
        }),
      });

      await expect(requestForOperation(client, operation)).rejects.toMatchObject({
        name: 'BookingEngineApiErrorV1',
        status,
        code,
        message: 'Documented public error.',
      });
    },
  );

  it.each([
    { operation: 'property', status: 404, code: 'route_not_found' },
    { operation: 'availability', status: 404, code: 'quote_unavailable' },
    { operation: 'quote', status: 404, code: 'route_not_found' },
    { operation: 'requestToBook', status: 409, code: 'property_not_found' },
    { operation: 'property', status: 500, code: 'validation_failed' },
    { operation: 'availability', status: 500, code: 'validation_failed' },
    { operation: 'quote', status: 500, code: 'validation_failed' },
    { operation: 'requestToBook', status: 500, code: 'validation_failed' },
  ] as const)(
    'rejects the invalid $operation $status $code error tuple',
    async ({ operation, status, code }) => {
      const client = createBookingEngineClientV1({
        baseUrl: 'https://api.example.test',
        fetch: async () => ({
          ok: false,
          status,
          json: async () => ({
            error: {
              code,
              message: 'Wrong public error.',
            },
          }),
        }),
      });

      await expect(requestForOperation(client, operation)).rejects.toMatchObject({
        name: 'BookingEngineApiErrorV1',
        status,
        code: 'internal_error',
        message: 'The public API returned an invalid error response.',
      });
    },
  );

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

  it('defines the exact public validation issue schema', () => {
    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<string, unknown>;
    expect(schemas['PublicValidationIssueV1']).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['field', 'code', 'message'],
      properties: {
        field: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z][A-Za-z0-9_.\\[\\]-]*(?![\\s\\S])',
        },
        code: {
          type: 'string',
          enum: [
            'invalid_input',
            'missing_field',
            'invalid_string',
            'empty_string',
            'string_too_long',
            'invalid_identifier',
            'invalid_date',
            'non_positive_length',
            'interval_too_long',
            'invalid_guest_count',
            'invalid_email',
            'invalid_value',
            'unknown_field',
          ],
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          pattern:
            '^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$',
        },
      },
    });

    const errorResponseSchema = schemas['PublicApiErrorResponseV1'] as {
      readonly properties?: {
        readonly error?: {
          readonly properties?: { readonly details?: unknown };
        };
      };
    };
    expect(errorResponseSchema.properties?.error?.properties?.details).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/PublicValidationIssueV1' },
    });
  });

  it('returns a rejected Promise when getPublicProperty has no property identifier', async () => {
    const fetcher = vi.fn();
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });
    let rejection: Promise<PublicPropertyV1> | undefined;

    expect(() => {
      rejection = client.getPublicProperty();
    }).not.toThrow();
    if (rejection === undefined) {
      throw new TypeError('getPublicProperty must return a Promise.');
    }
    const caught = await rejection.catch((error: unknown) => error);
    expect(caught).toEqual(
      expect.objectContaining({
        name: 'TypeError',
        message: 'A propertyId or defaultPropertyId is required.',
      }),
    );
    await expect(client.getPublicProperty()).rejects.toThrow(
      'A propertyId or defaultPropertyId is required.',
    );
    expect(fetcher).not.toHaveBeenCalled();
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

    const client = createBookingEngineClientV1({
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
    const client = createBookingEngineClientV1({
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

  it('returns exact request fields that can be sent through the client', async () => {
    const input = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
      message: 'Please leave the porch light on.',
    } satisfies PublicRequestToBookInputV1;
    const validated = validatePublicRequestToBookV1(input);

    expect(validated).toEqual({ ok: true, value: input });
    if (!validated.ok) {
      throw new TypeError('The valid request must produce a value.');
    }
    expect(Object.isFrozen(validated.value)).toBe(true);
    expect(validated.value).not.toHaveProperty('nights');

    const fetcher = vi.fn(async (url: string, init: { readonly body?: string }) => {
      void url;
      void init;
      return {
        ok: true,
        status: 201,
        json: async () => requestResponse,
      };
    });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(
      client.requestToBook(property.id, validated.value, {
        idempotencyKey: 'validated-request-key',
      }),
    ).resolves.toEqual(requestResponse);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body ?? '{}')).toEqual(input);
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
    const client = createBookingEngineClientV1({
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
    await expect(unknownErrorResponse).rejects.toBeInstanceOf(BookingEngineApiErrorV1);
    await expect(unknownErrorResponse).rejects.toMatchObject({
      code: 'internal_error',
      status: 500,
      message: 'The public API returned an invalid error response.',
    });
  });

  it('rejects lone surrogates in response text and preserves valid astral pairs', async () => {
    const loneHighSurrogate = '\uD83C';
    const loneLowSurrogate = '\uDFE0';
    const astralCharacter = `${loneHighSurrogate}${loneLowSurrogate}`;
    const validName = `House ${astralCharacter}`;
    const scriptedResponses = [
      {
        ok: true,
        status: 200,
        body: { ...property, name: `Broken ${loneHighSurrogate}` },
      },
      {
        ok: true,
        status: 200,
        body: { ...property, hostNotes: `Broken ${loneLowSurrogate}` },
      },
      {
        ok: false,
        status: 500,
        body: {
          error: {
            code: 'internal_error',
            message: `Broken ${loneHighSurrogate}`,
          },
        },
      },
      {
        ok: false,
        status: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details: [
              {
                field: 'propertyId',
                code: 'invalid_identifier',
                message: `Broken ${loneLowSurrogate}`,
              },
            ],
          },
        },
      },
      { ok: true, status: 200, body: { ...property, name: validName } },
    ] as const;
    let responseIndex = 0;
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => {
        const scriptedResponse = scriptedResponses[responseIndex++];
        if (scriptedResponse === undefined) {
          throw new TypeError('A scripted response is required.');
        }
        return {
          ok: scriptedResponse.ok,
          status: scriptedResponse.status,
          json: async () => scriptedResponse.body,
        };
      },
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 200,
      code: 'internal_error',
      message: 'The public API returned an invalid response.',
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 200,
      code: 'internal_error',
      message: 'The public API returned an invalid response.',
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
      message: 'The public API returned an invalid error response.',
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 400,
      code: 'internal_error',
      message: 'The public API returned an invalid error response.',
    });

    const decodedProperty = await client.getProperty(property.id);
    expect(decodedProperty.name).toBe(validName);
    expect(Array.from(astralCharacter)).toEqual([astralCharacter]);
    const decodedNameCodePoints = Array.from(decodedProperty.name);
    expect(decodedNameCodePoints[decodedNameCodePoints.length - 1]).toBe(astralCharacter);
  });

  it('enforces operation-specific response statuses before accepting bodies', async () => {
    const scriptedResponses = [
      { ok: true, status: 201, body: property },
      { ok: true, status: 200, body: requestResponse },
      {
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'request_conflict',
            message: 'The request conflicts with an existing request.',
          },
        },
      },
      {
        ok: false,
        status: 500,
        body: {
          error: {
            code: 'internal_error',
            message: 'Service temporarily unavailable.',
          },
        },
      },
    ] as const;
    let responseIndex = 0;
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => {
        const scriptedResponse = scriptedResponses[responseIndex++];
        if (scriptedResponse === undefined) {
          throw new TypeError('A scripted response is required.');
        }
        return {
          ok: scriptedResponse.ok,
          status: scriptedResponse.status,
          json: async () => scriptedResponse.body,
        };
      },
    });
    const bookingInput = {
      ...requestedStay,
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 201,
      code: 'internal_error',
      message: 'The public API returned an invalid response.',
    });
    await expect(
      client.requestToBook(property.id, bookingInput, { idempotencyKey: 'wrong-status-key' }),
    ).rejects.toMatchObject({
      status: 200,
      code: 'internal_error',
      message: 'The public API returned an invalid response.',
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      status: 409,
      code: 'internal_error',
      message: 'The public API returned an invalid error response.',
    });
    await expect(client.getQuote(property.id, requestedStay)).rejects.toMatchObject({
      status: 500,
      code: 'internal_error',
      message: 'Service temporarily unavailable.',
    });
  });

  it('binds every decoded success body to its request context', async () => {
    const shiftedStay = { arrival: '2026-08-02', departure: '2026-08-04' } as const;
    const shiftedQuote = {
      ...quoteResponse,
      ...shiftedStay,
      nightly: [
        { date: '2026-08-02', amountMinor: 12_500, source: 'base' },
        { date: '2026-08-03', amountMinor: 12_500, source: 'base' },
      ],
    } as const;
    const responseBodies = [
      { ...property, id: 'other-property' },
      {
        propertyId: 'other-property',
        ...requestedStay,
        nights: 2,
        available: true,
      },
      {
        propertyId: property.id,
        ...shiftedStay,
        nights: 2,
        available: true,
      },
      { ...quoteResponse, propertyId: 'other-property' },
      shiftedQuote,
      {
        ...requestResponse,
        propertyId: 'other-property',
        quote: { ...quoteResponse, propertyId: 'other-property' },
      },
      {
        ...requestResponse,
        ...shiftedStay,
        quote: shiftedQuote,
      },
      { ...requestResponse, guestCount: 3 },
    ] as const;
    let responseIndex = 0;
    const fetcher = vi.fn(async () => {
      const currentResponseIndex = responseIndex++;
      const body = responseBodies[currentResponseIndex];
      if (body === undefined) {
        throw new TypeError('A scripted response body is required.');
      }
      return {
        ok: true,
        status: currentResponseIndex < 5 ? 200 : 201,
        json: async () => body,
      };
    });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });
    const bookingInput = {
      ...requestedStay,
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };
    const requests = [
      () => client.getProperty(property.id),
      () => client.getAvailability(property.id, requestedStay),
      () => client.getAvailability(property.id, requestedStay),
      () => client.getQuote(property.id, requestedStay),
      () => client.getQuote(property.id, requestedStay),
      () =>
        client.requestToBook(property.id, bookingInput, {
          idempotencyKey: 'wrong-property-key',
        }),
      () =>
        client.requestToBook(property.id, bookingInput, {
          idempotencyKey: 'wrong-stay-key',
        }),
      () =>
        client.requestToBook(property.id, bookingInput, {
          idempotencyKey: 'wrong-guest-count-key',
        }),
    ] as const;

    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({
        code: 'internal_error',
        message: 'The public API returned an invalid response.',
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(responseBodies.length);
  });

  it.each([
    ['malformed success body', true, 200, 'Malformed JSON'],
    ['empty error body', false, 400, 'Unexpected end of JSON input'],
    ['HTML success body', true, 201, 'Unexpected token <'],
    ['truncated error body', false, 502, 'Unexpected end of JSON input'],
  ])(
    'maps a rejected response.json() for a %s to the documented SDK error',
    async (_case, ok, status, parseMessage) => {
      const client = createBookingEngineClientV1({
        baseUrl: 'https://api.example.test',
        fetch: async () => ({
          ok,
          status,
          json: async () => {
            throw new SyntaxError(parseMessage);
          },
        }),
      });

      await expect(client.getProperty(property.id)).rejects.toStrictEqual(
        new BookingEngineApiErrorV1(status, {
          code: 'internal_error',
          message: ok
            ? 'The public API returned an invalid response.'
            : 'The public API returned an invalid error response.',
        }),
      );
    },
  );

  it('rejects public properties with enum values outside the v1 contract', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...property, propertyType: 'penthouse' }),
    }));
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      code: 'internal_error',
      status: 200,
      message: 'The public API returned an invalid response.',
    });
  });

  it('uses the canonical property response bounds at runtime', async () => {
    const astralCharacter = '\u{1f3e0}';
    const maximumNameLength =
      PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicPropertyV1.bounds.name.maxLength;
    const nameAtMaximum = astralCharacter.repeat(maximumNameLength);
    const responses: readonly unknown[] = [
      {
        ...property,
        name: nameAtMaximum,
        bathroomCount: 1,
        maximumGuests: 1,
        bedConfiguration: [{ type: 'queen', quantity: 100 }],
        amenities: ['a'.repeat(80)],
      },
      { ...property, name: nameAtMaximum + astralCharacter },
      { ...property, bathroomCount: 0 },
      { ...property, maximumGuests: 0 },
      { ...property, amenities: ['a'.repeat(81)] },
      { ...property, bedConfiguration: [] },
      { ...property, bedConfiguration: [{ type: 'queen', quantity: 101 }] },
    ];
    let responseIndex = 0;
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => responses[responseIndex++],
      }),
    });

    await expect(client.getProperty(property.id)).resolves.toMatchObject({
      name: nameAtMaximum,
      bathroomCount: 1,
      maximumGuests: 1,
      amenities: ['a'.repeat(80)],
    });
    for (let index = 1; index < responses.length; index += 1) {
      await expect(client.getProperty(property.id)).rejects.toMatchObject({
        code: 'internal_error',
        status: 200,
        message: 'The public API returned an invalid response.',
      });
    }
  });

  it('deep-freezes the OpenAPI document and preserves its served representation', () => {
    const servedDocument = JSON.stringify(PUBLIC_BOOKING_OPENAPI_V1);
    const paths = PUBLIC_BOOKING_OPENAPI_V1.paths as Record<string, unknown>;
    const requestPath = paths[PUBLIC_BOOKING_PATHS_V1.requestToBook] as Record<string, unknown>;
    const requestOperation = requestPath['post'] as Record<string, unknown>;
    const schemas = PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<string, unknown>;
    const requestSchema = schemas['PublicRequestToBookInputV1'] as Record<string, unknown>;
    const requestProperties = requestSchema['properties'] as Record<string, unknown>;
    const guestNameSchema = requestProperties['guestName'] as Record<string, unknown>;
    const requiredFields = requestSchema['required'] as readonly unknown[];

    expectDeeplyFrozen(PUBLIC_BOOKING_OPENAPI_V1);
    expect(Reflect.set(PUBLIC_BOOKING_OPENAPI_V1.info, 'title', 'Changed API')).toBe(false);
    expect(Reflect.set(requestOperation, 'description', 'Changed operation')).toBe(false);
    expect(Reflect.set(guestNameSchema, 'maxLength', 1)).toBe(false);
    expect(Reflect.set(requiredFields, 0, 'privateField')).toBe(false);
    expect(JSON.stringify(PUBLIC_BOOKING_OPENAPI_V1)).toBe(servedDocument);
  });

  it('deep-freezes public metadata so mutations cannot redirect paths or weaken validation', async () => {
    const manifest = PUBLIC_BOOKING_CONTRACT_MANIFEST_V1;
    const propertyOperation = manifest.operations.property;
    const propertyFields = manifest.schemas.PublicPropertyV1.fields;
    const propertyRequired = manifest.schemas.PublicPropertyV1.required;
    const propertyBounds = manifest.schemas.PublicPropertyV1.bounds;
    const quantityBounds = propertyBounds.bedConfiguration.items.properties.quantity;
    const validationIssueBounds = manifest.schemas.PublicValidationIssueV1.bounds;

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.operations)).toBe(true);
    expect(Object.isFrozen(manifest.schemas)).toBe(true);
    expect(Object.isFrozen(propertyOperation)).toBe(true);
    expect(Object.isFrozen(propertyOperation.statuses)).toBe(true);
    expect(Object.isFrozen(propertyFields)).toBe(true);
    expect(Object.isFrozen(propertyRequired)).toBe(true);
    expect(Object.isFrozen(propertyBounds)).toBe(true);
    expect(Object.isFrozen(propertyBounds.bedConfiguration)).toBe(true);
    expect(Object.isFrozen(quantityBounds)).toBe(true);
    expect(Object.isFrozen(validationIssueBounds)).toBe(true);
    expect(Object.isFrozen(validationIssueBounds.field)).toBe(true);
    expect(Reflect.set(propertyOperation, 'path', '/changed')).toBe(false);
    expect(Reflect.set(propertyOperation.statuses, 0, 500)).toBe(false);
    expect(Reflect.set(propertyFields, 0, 'privateField')).toBe(false);
    expect(Reflect.set(propertyRequired, 0, 'privateField')).toBe(false);
    expect(Reflect.set(quantityBounds, 'maximum', 101)).toBe(false);
    expect(Reflect.set(validationIssueBounds.field, 'maxLength', 129)).toBe(false);
    expect(propertyOperation.path).toBe('/v1/properties/{propertyId}');
    expect(propertyOperation.statuses).toEqual([200, 400, 404, 500]);
    expect(propertyFields[0]).toBe('id');
    expect(quantityBounds.maximum).toBe(100);
    expect(propertyRequired[0]).toBe('id');
    expect(validationIssueBounds.field.maxLength).toBe(128);

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...property,
          bedConfiguration: [{ type: 'queen', quantity: 101 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details: [
              {
                field: 'a'.repeat(129),
                code: 'unknown_field',
                message: 'Unknown field.',
              },
            ],
          },
        }),
      });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      code: 'internal_error',
      status: 200,
      message: 'The public API returned an invalid response.',
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      code: 'internal_error',
      status: 400,
      message: 'The public API returned an invalid error response.',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.example.test/v1/properties/sample-bungalow',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/v1/properties/sample-bungalow',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('constructs portable idempotency headers and rejects unsafe keys before fetch', async () => {
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
      async (url: string, init: { headers: Readonly<Record<string, string>>; body?: string }) => {
        const headers = new Headers(init.headers);
        expect(headers.get('Idempotency-Key')).toBe('sdk-retry-key');
        return {
          ok: true,
          status: 201,
          json: async () => {
            void url;
            return request;
          },
        };
      },
    );
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });
    const bookingInput = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };

    await expect(
      client.requestToBook(property.id, bookingInput, { idempotencyKey: 'sdk-retry-key' }),
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
    for (const idempotencyKey of [
      'key with space',
      'key\u0009with-control',
      'caf\u00e9',
      '\u{1f3e0}',
    ]) {
      await expect(
        client.requestToBook(property.id, bookingInput, { idempotencyKey }),
      ).rejects.toMatchObject({
        name: 'PublicContractValidationErrorV1',
        details: [{ field: 'idempotencyKey', code: 'invalid_string' }],
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('decodes non-pending replay responses with complete lifecycle metadata', async () => {
    const requestResponseSchema = (
      PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<
        string,
        {
          readonly properties?: {
            readonly status?: { readonly type?: unknown; readonly enum?: readonly string[] };
          };
        }
      >
    )['PublicRequestToBookV1'];
    expect(requestResponseSchema?.properties?.status).toEqual({
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'expired'],
    });
    expect(Object.isFrozen(requestResponseSchema?.properties?.status?.enum)).toBe(true);
    expect(PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook).toEqual({
      method: 'POST',
      path: '/v1/properties/{propertyId}/request-to-book',
      operationId: 'requestToBookV1',
      statuses: [201, 400, 404, 409, 500],
      errorCodesByStatus: {
        400: ['validation_failed'],
        404: ['property_not_found', 'quote_unavailable'],
        409: ['stay_unavailable', 'request_conflict'],
        500: ['internal_error'],
      },
      requestSchema: 'PublicRequestToBookInputV1',
      responseSchema: 'PublicRequestToBookV1',
    });

    const response = {
      id: 'request-001',
      propertyId: property.id,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      nights: 2,
      guestCount: 2,
      status: 'approved',
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
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: true,
        status: 201,
        json: async () => response,
      }),
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
        { idempotencyKey: 'sdk-replay-key' },
      ),
    ).resolves.toEqual(response);
  });

  it('reports missing request options as a public validation error before fetch', async () => {
    const fetcher = vi.fn();
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });
    const input = {
      arrival: '2026-08-01',
      departure: '2026-08-03',
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
    };

    await expect(
      (client.requestToBook as unknown as (...args: unknown[]) => Promise<unknown>)(
        property.id,
        input,
        undefined,
      ),
    ).rejects.toMatchObject({
      name: 'PublicContractValidationErrorV1',
      code: 'validation_failed',
      details: [{ field: 'idempotencyKey', code: 'missing_field' }],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects inconsistent stay, quote arithmetic, and nested request payloads', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          propertyId: property.id,
          arrival: '2026-08-01',
          departure: '2026-08-03',
          nights: 1,
          available: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          propertyId: property.id,
          arrival: '2026-08-01',
          departure: '2026-08-03',
          nights: 2,
          currency: 'CAD',
          nightly: [
            { date: '2026-08-01', amountMinor: 100, source: 'base' },
            { date: '2026-08-02', amountMinor: 100, source: 'base' },
          ],
          nightlySubtotalMinor: 200,
          cleaningFeeMinor: 25,
          totalMinor: 999,
          minimumStayNights: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
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
            departure: '2026-08-04',
            nights: 3,
            currency: 'CAD',
            nightly: [
              { date: '2026-08-01', amountMinor: 100, source: 'base' },
              { date: '2026-08-02', amountMinor: 100, source: 'base' },
              { date: '2026-08-03', amountMinor: 100, source: 'base' },
            ],
            nightlySubtotalMinor: 300,
            cleaningFeeMinor: 25,
            totalMinor: 325,
            minimumStayNights: 1,
          },
          createdAt: '2026-07-12T12:00:00.000Z',
        }),
      });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(
      client.getAvailability(property.id, { arrival: '2026-08-01', departure: '2026-08-03' }),
    ).rejects.toMatchObject({ name: 'BookingEngineApiErrorV1', code: 'internal_error' });
    await expect(
      client.getQuote(property.id, { arrival: '2026-08-01', departure: '2026-08-03' }),
    ).rejects.toMatchObject({ name: 'BookingEngineApiErrorV1', code: 'internal_error' });
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
        { idempotencyKey: 'nested-shape-key' },
      ),
    ).rejects.toMatchObject({ name: 'BookingEngineApiErrorV1', code: 'internal_error' });
  });

  it('uses one public minor-amount ceiling without narrowing valid quote totals', async () => {
    const quote = {
      propertyId: property.id,
      arrival: '2026-08-01',
      departure: '2026-08-02',
      nights: 1,
      currency: 'CAD',
      nightly: [
        {
          date: '2026-08-01',
          amountMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
          source: 'base',
        },
      ],
      nightlySubtotalMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
      cleaningFeeMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
      totalMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 * 2,
      minimumStayNights: 1,
    };
    const request = {
      id: 'request-amount-boundary',
      propertyId: property.id,
      arrival: quote.arrival,
      departure: quote.departure,
      nights: quote.nights,
      guestCount: 2,
      status: 'pending',
      quote,
      createdAt: '2026-07-12T12:00:00.000Z',
    };
    const quoteSchema = (PUBLIC_BOOKING_OPENAPI_V1.components.schemas as Record<string, unknown>)[
      'PublicQuoteV1'
    ];
    expect(quoteSchema).toMatchObject({
      properties: {
        nightly: {
          items: {
            properties: {
              amountMinor: {
                minimum: 0,
                maximum: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
              },
            },
          },
        },
        nightlySubtotalMinor: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        cleaningFeeMinor: { minimum: 0, maximum: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 },
        totalMinor: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    });

    const fetcher = vi.fn(async (url: string) => {
      const isRequestToBook = url.endsWith('/request-to-book');
      return {
        ok: true,
        status: isRequestToBook ? 201 : 200,
        json: async () => (isRequestToBook ? request : quote),
      };
    });
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: fetcher,
    });

    await expect(
      client.getQuote(property.id, { arrival: quote.arrival, departure: quote.departure }),
    ).resolves.toEqual(quote);
    await expect(
      client.requestToBook(
        property.id,
        {
          arrival: quote.arrival,
          departure: quote.departure,
          guestCount: 2,
          guestName: 'Ada Lovelace',
          guestEmail: 'ada@example.test',
        },
        { idempotencyKey: 'amount-boundary-key' },
      ),
    ).resolves.toEqual(request);
  });

  it('rejects over-limit nightly and cleaning amounts in quote and nested responses', async () => {
    const quote = {
      propertyId: property.id,
      arrival: '2026-08-01',
      departure: '2026-08-02',
      nights: 1,
      currency: 'CAD',
      nightly: [{ date: '2026-08-01', amountMinor: 100, source: 'base' }],
      nightlySubtotalMinor: 100,
      cleaningFeeMinor: 25,
      totalMinor: 125,
      minimumStayNights: 1,
    };
    const overLimitNightlyQuote = {
      ...quote,
      nightly: [
        {
          date: quote.arrival,
          amountMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 + 1,
          source: 'base',
        },
      ],
      nightlySubtotalMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 + 1,
      totalMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 + 1 + quote.cleaningFeeMinor,
    };
    const overLimitCleaningQuote = {
      ...quote,
      cleaningFeeMinor: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 + 1,
      totalMinor: quote.nightlySubtotalMinor + PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 + 1,
    };
    const request = {
      id: 'request-over-limit-amount',
      propertyId: property.id,
      arrival: quote.arrival,
      departure: quote.departure,
      nights: quote.nights,
      guestCount: 2,
      status: 'pending',
      quote,
      createdAt: '2026-07-12T12:00:00.000Z',
    };
    const cases = [
      { operation: 'quote', body: overLimitNightlyQuote },
      { operation: 'quote', body: overLimitCleaningQuote },
      { operation: 'request', body: { ...request, quote: overLimitNightlyQuote } },
      { operation: 'request', body: { ...request, quote: overLimitCleaningQuote } },
    ] as const;

    for (const testCase of cases) {
      const client = createBookingEngineClientV1({
        baseUrl: 'https://api.example.test',
        fetch: async () => ({
          ok: true,
          status: testCase.operation === 'request' ? 201 : 200,
          json: async () => testCase.body,
        }),
      });
      const response =
        testCase.operation === 'request'
          ? client.requestToBook(
              property.id,
              {
                arrival: quote.arrival,
                departure: quote.departure,
                guestCount: 2,
                guestName: 'Ada Lovelace',
                guestEmail: 'ada@example.test',
              },
              { idempotencyKey: 'over-limit-amount-key' },
            )
          : client.getQuote(property.id, {
              arrival: quote.arrival,
              departure: quote.departure,
            });

      await expect(response).rejects.toMatchObject({
        name: 'BookingEngineApiErrorV1',
        code: 'internal_error',
      });
    }
  });

  it('rejects impossible minimum stays in direct and nested quotes', async () => {
    const quote = {
      propertyId: property.id,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      nights: 2,
      currency: 'CAD',
      nightly: [
        { date: '2026-08-01', amountMinor: 100, source: 'base' },
        { date: '2026-08-02', amountMinor: 100, source: 'base' },
      ],
      nightlySubtotalMinor: 200,
      cleaningFeeMinor: 25,
      totalMinor: 225,
      minimumStayNights: 2,
    };
    const request = {
      id: 'request-minimum-stay',
      propertyId: property.id,
      arrival: quote.arrival,
      departure: quote.departure,
      nights: quote.nights,
      guestCount: 2,
      status: 'pending',
      quote,
      createdAt: '2026-07-12T12:00:00.000Z',
    };
    const malformedQuote = { ...quote, minimumStayNights: quote.nights + 1 };
    const lowerMinimumQuote = { ...quote, minimumStayNights: quote.nights - 1 };
    const cases = [
      { operation: 'quote', body: malformedQuote, accepted: false },
      {
        operation: 'request',
        body: { ...request, quote: malformedQuote },
        accepted: false,
      },
      { operation: 'quote', body: quote, accepted: true },
      { operation: 'request', body: request, accepted: true },
      { operation: 'quote', body: lowerMinimumQuote, accepted: true },
      {
        operation: 'request',
        body: { ...request, quote: lowerMinimumQuote },
        accepted: true,
      },
    ] as const;

    for (const testCase of cases) {
      const client = createBookingEngineClientV1({
        baseUrl: 'https://api.example.test',
        fetch: async () => ({
          ok: true,
          status: testCase.operation === 'request' ? 201 : 200,
          json: async () => testCase.body,
        }),
      });
      const response =
        testCase.operation === 'request'
          ? client.requestToBook(
              property.id,
              {
                arrival: quote.arrival,
                departure: quote.departure,
                guestCount: 2,
                guestName: 'Ada Lovelace',
                guestEmail: 'ada@example.test',
              },
              { idempotencyKey: 'minimum-stay-key' },
            )
          : client.getQuote(property.id, {
              arrival: quote.arrival,
              departure: quote.departure,
            });

      if (testCase.accepted) {
        await expect(response).resolves.toEqual(testCase.body);
      } else {
        await expect(response).rejects.toMatchObject({
          name: 'BookingEngineApiErrorV1',
          code: 'internal_error',
        });
      }
    }
  });

  it('normalizes custom property-ID labels into strict public issues', async () => {
    const safeField = 'route.propertyId';
    const safeValidation = validatePublicPropertyIdV1('!', safeField);
    expect(safeValidation).toEqual({
      ok: false,
      errors: [
        {
          field: safeField,
          code: 'invalid_identifier',
          message: `${safeField} must contain only letters, numbers, underscores, and hyphens.`,
        },
      ],
    });

    const unsafeFields = [
      '<script>alert(1)</script>',
      `a${'x'.repeat(128)}`,
      'line\nbreak',
    ] as const;
    const unsafeValidations = unsafeFields.map((field) => validatePublicPropertyIdV1('!', field));
    const canonicalIssue = {
      field: 'propertyId',
      code: 'invalid_identifier',
      message: 'propertyId must be a valid public identifier.',
    };
    for (const validation of unsafeValidations) {
      expect(validation).toEqual({ ok: false, errors: [canonicalIssue] });
    }

    const details: PublicValidationIssueV1[] = [];
    for (const validation of [safeValidation, ...unsafeValidations]) {
      if (!validation.ok) {
        details.push(...validation.errors);
      }
    }
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details,
          },
        }),
      }),
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      code: 'validation_failed',
      details,
    });
  });

  it('accepts issues from every exported validator at the strict error boundary', async () => {
    const validations = [
      validatePublicPropertyIdV1(undefined),
      validatePublicStayV1(undefined),
      validatePublicAvailabilityRequestV1({
        arrival: '2026-08-01',
        departure: '2026-08-01',
      }),
      validatePublicQuoteRequestV1({
        arrival: 'not-a-date',
        departure: '2026-08-02',
      }),
      validatePublicRequestToBookV1({
        arrival: '2026-08-01',
        departure: '2026-08-02',
        guestCount: 0,
        guestName: '',
        guestEmail: 'invalid',
        message: '\u0001',
      }),
      validatePublicIdempotencyKeyV1('\n'),
    ];
    const details: PublicValidationIssueV1[] = [];
    for (const validation of validations) {
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        details.push(...validation.errors);
      }
    }
    expect(details.length).toBeGreaterThanOrEqual(validations.length);

    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details,
          },
        }),
      }),
    });
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      code: 'validation_failed',
      details,
    });
  });

  it('canonicalizes hostile unknown fields into valid public issues', async () => {
    const safeField = 'safe_extra';
    const hostileField = '<script>alert(1)</script>';
    const overlongField = `a${'x'.repeat(128)}`;
    const controlField = 'line\nbreak';
    const validation = validatePublicStayV1({
      arrival: '2026-08-01',
      departure: '2026-08-03',
      [safeField]: true,
      [hostileField]: true,
      [overlongField]: true,
      [controlField]: true,
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) {
      throw new Error('Expected unknown fields to fail validation.');
    }

    const canonicalIssue = {
      field: 'request',
      code: 'unknown_field',
      message: 'request contains a field that is not part of the public contract.',
    };
    expect(validation.errors).toEqual([
      {
        field: safeField,
        code: 'unknown_field',
        message: `${safeField} is not part of the public contract.`,
      },
      canonicalIssue,
      canonicalIssue,
      canonicalIssue,
    ]);
    for (const detail of validation.errors) {
      expect('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz').toContain(detail.field[0]);
      for (const character of detail.field.slice(1)) {
        expect('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.[]-').toContain(
          character,
        );
      }
      expect(detail.field.length).toBeLessThanOrEqual(128);
      expect(detail.message.length).toBeGreaterThanOrEqual(1);
      expect(detail.message.length).toBeLessThanOrEqual(2_000);
      for (const character of detail.message) {
        const codePoint = character.codePointAt(0) ?? 0;
        expect(codePoint >= 32 && codePoint !== 127).toBe(true);
      }
    }

    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details: validation.errors,
          },
        }),
      }),
    });

    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      code: 'validation_failed',
      status: 400,
      details: validation.errors,
    });
  });

  it('enforces public validation issue bounds and exact fields at runtime', async () => {
    const validDetail = {
      field: 'a'.repeat(128),
      code: 'unknown_field',
      message: 'm'.repeat(2_000),
    };
    const details: readonly unknown[] = [
      { ...validDetail, field: '1guestCount' },
      { ...validDetail, field: 'a'.repeat(129) },
      { ...validDetail, code: 'private_validation_code' },
      { ...validDetail, message: '' },
      { ...validDetail, message: 'm'.repeat(2_001) },
      { ...validDetail, private: 'not allowed' },
      validDetail,
    ];
    let responseIndex = 0;
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'validation_failed',
            message: 'Request validation failed.',
            details: [details[responseIndex++]],
          },
        }),
      }),
    });

    for (let index = 0; index < details.length - 1; index += 1) {
      await expect(client.getProperty(property.id)).rejects.toMatchObject({
        code: 'internal_error',
        status: 400,
        message: 'The public API returned an invalid error response.',
      });
    }
    await expect(client.getProperty(property.id)).rejects.toMatchObject({
      name: 'BookingEngineApiErrorV1',
      code: 'validation_failed',
      status: 400,
      details: [validDetail],
    });
  });
});
