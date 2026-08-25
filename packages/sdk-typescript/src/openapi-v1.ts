import type {
  PublicApiVersionV1,
  PublicPropertyV1,
  PublicRequestToBookV1,
} from './public-contract-v1.js';
import { PUBLIC_BOOKING_CONTRACT_MANIFEST_V1 } from './contract-manifest-v1.js';

export const PUBLIC_BOOKING_PATHS_V1 = Object.freeze({
  property: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.path,
  availability: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.path,
  quote: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.path,
  requestToBook: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.path,
});

export const PUBLIC_BOOKING_OPENAPI_PATH_V1 = PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.openapiPath;

export interface PublicOpenApiDocumentV1 {
  readonly openapi: '3.0.3';
  readonly info: {
    readonly title: string;
    readonly version: string;
  };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: {
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly schemas: Readonly<Record<string, unknown>>;
  };
}

const propertySchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicPropertyV1.required,
  properties: {
    id: { type: 'string', maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    country: { type: 'string', pattern: '^[A-Z]{2}$' },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    propertyType: {
      type: 'string',
      enum: ['apartment', 'bungalow', 'cabin', 'cottage', 'house', 'studio', 'villa'],
    },
    bedroomCount: { type: 'integer', minimum: 0, maximum: 100 },
    bedConfiguration: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'quantity'],
        properties: {
          type: { type: 'string', enum: ['bunk', 'double', 'king', 'queen', 'single', 'sofa-bed'] },
          quantity: { type: 'integer', minimum: 1, maximum: 16 },
        },
      },
    },
    bathroomCount: { type: 'integer', minimum: 0, maximum: 100 },
    maximumGuests: { type: 'integer', minimum: 0, maximum: 200 },
    amenities: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    hostNotes: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const satisfies Record<string, unknown>;

const staySchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicStayInputV1.required,
  properties: {
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
  },
} as const satisfies Record<string, unknown>;

const availabilitySchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicAvailabilityV1.required,
  properties: {
    propertyId: { type: 'string', maxLength: 64 },
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
    nights: { type: 'integer', minimum: 1, maximum: 3660 },
    available: { type: 'boolean' },
  },
} as const satisfies Record<string, unknown>;

const quoteSchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicQuoteV1.required,
  properties: {
    propertyId: { type: 'string', maxLength: 64 },
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
    nights: { type: 'integer', minimum: 1, maximum: 3660 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    nightly: {
      type: 'array',
      maxItems: 3660,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'amountMinor', 'source'],
        properties: {
          date: { type: 'string', format: 'date' },
          amountMinor: { type: 'integer', minimum: 0, maximum: 1000000000 },
          source: { type: 'string', enum: ['base', 'seasonal_override'] },
        },
      },
    },
    nightlySubtotalMinor: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    cleaningFeeMinor: { type: 'integer', minimum: 0, maximum: 1000000000 },
    totalMinor: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    minimumStayNights: { type: 'integer', minimum: 1, maximum: 3660 },
  },
} as const satisfies Record<string, unknown>;

const requestInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicRequestToBookInputV1.required,
  properties: {
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
    guestCount: { type: 'integer', minimum: 1, maximum: 200 },
    guestName: { type: 'string', minLength: 1, maxLength: 120 },
    guestEmail: { type: 'string', format: 'email', maxLength: 254 },
    message: { type: 'string', maxLength: 2000 },
  },
} as const satisfies Record<string, unknown>;

const requestResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicRequestToBookV1.required,
  properties: {
    id: { type: 'string', maxLength: 64 },
    propertyId: { type: 'string', maxLength: 64 },
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
    nights: { type: 'integer', minimum: 1, maximum: 3660 },
    guestCount: { type: 'integer', minimum: 1, maximum: 200 },
    status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] },
    quote: { $ref: '#/components/schemas/PublicQuoteV1' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const satisfies Record<string, unknown>;

const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'validation_failed',
            'property_not_found',
            'quote_unavailable',
            'stay_unavailable',
            'request_conflict',
            'route_not_found',
            'method_not_allowed',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        details: { type: 'array', items: { type: 'object' } },
      },
    },
  },
} as const satisfies Record<string, unknown>;

export const PUBLIC_BOOKING_OPENAPI_V1: PublicOpenApiDocumentV1 = {
  openapi: '3.0.3',
  info: { title: 'Booking Engine Public API', version: '1.0.0' },
  paths: {
    [PUBLIC_BOOKING_PATHS_V1.property]: {
      get: {
        operationId: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.operationId,
        parameters: [{ $ref: '#/components/parameters/PropertyId' }],
        responses: {
          '200': {
            description: 'Guest-visible property.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublicPropertyV1' } },
            },
          },
          '404': {
            description: 'Property not found.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
        },
      },
    },
    [PUBLIC_BOOKING_PATHS_V1.availability]: {
      get: {
        operationId: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.operationId,
        parameters: [
          { $ref: '#/components/parameters/PropertyId' },
          {
            name: 'arrival',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date' },
          },
          {
            name: 'departure',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date' },
          },
        ],
        responses: {
          '200': {
            description: 'Availability for a local-date stay.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublicAvailabilityV1' } },
            },
          },
          '400': {
            description: 'Invalid stay.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
        },
      },
    },
    [PUBLIC_BOOKING_PATHS_V1.quote]: {
      post: {
        operationId: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.operationId,
        parameters: [{ $ref: '#/components/parameters/PropertyId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PublicStayInputV1' } },
          },
        },
        responses: {
          '200': {
            description: 'Minor-unit quote.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublicQuoteV1' } },
            },
          },
          '400': {
            description: 'Invalid stay.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
          '404': {
            description: 'Quote unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
        },
      },
    },
    [PUBLIC_BOOKING_PATHS_V1.requestToBook]: {
      post: {
        operationId: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.operationId,
        parameters: [
          { $ref: '#/components/parameters/PropertyId' },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PublicRequestToBookInputV1' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Pending request-to-book acknowledgement.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicRequestToBookV1' },
              },
            },
          },
          '400': {
            description: 'Invalid request.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
          '409': {
            description: 'The idempotency key conflicts with an existing request.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicApiErrorResponseV1' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      PropertyId: {
        name: 'propertyId',
        in: 'path',
        required: true,
        schema: { type: 'string', maxLength: 64 },
      },
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    schemas: {
      PublicPropertyV1: propertySchema,
      PublicStayInputV1: staySchema,
      PublicStayV1: {
        type: 'object',
        additionalProperties: false,
        required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicStayV1.required,
        properties: {
          arrival: { type: 'string', format: 'date' },
          departure: { type: 'string', format: 'date' },
          nights: { type: 'integer', minimum: 1, maximum: 3660 },
        },
      },
      PublicAvailabilityV1: availabilitySchema,
      PublicQuoteV1: quoteSchema,
      PublicRequestToBookInputV1: requestInputSchema,
      PublicRequestToBookV1: requestResponseSchema,
      PublicApiErrorResponseV1: errorResponseSchema,
    },
  },
};

// Keep these imports in the contract package typechecked as consumer-facing names.
export type PublicOpenApiContractTypesV1 = {
  readonly version: PublicApiVersionV1;
  readonly property: PublicPropertyV1;
  readonly request: PublicRequestToBookV1;
};
