import {
  deepFreezeV1,
  PUBLIC_API_ERROR_CODES_V1,
  PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1,
  PUBLIC_BOOKING_REQUEST_STATUSES_V1,
  PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1,
  PUBLIC_BOUNDED_TEXT_PATTERN_V1,
  PUBLIC_IDEMPOTENCY_KEY_PATTERN_V1,
  PUBLIC_IDENTIFIER_PATTERN_V1,
  PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
  PUBLIC_NONBLANK_CONTROL_SAFE_TEXT_PATTERN_V1,
  PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1,
  PUBLIC_VALIDATION_CODES_V1,
  PUBLIC_VALIDATION_ISSUE_BOUNDS_V1,
  PUBLIC_VALIDATION_ISSUE_FIELD_PATTERN_V1,
} from './contract-constraints-v1.js';
import { PUBLIC_BOOKING_CONTRACT_MANIFEST_V1 } from './contract-manifest-v1.js';
import type {
  PublicApiVersionV1,
  PublicApiErrorCodeV1,
  PublicPropertyV1,
  PublicRequestToBookV1,
} from './public-contract-v1.js';

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

const identifierSchema = {
  type: 'string',
  ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.id,
  pattern: PUBLIC_IDENTIFIER_PATTERN_V1,
} as const;

const propertySchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicPropertyV1.required,
  properties: {
    id: identifierSchema,
    name: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.name,
      pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
    },
    summary: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.summary,
      pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
    },
    country: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.country,
      pattern: '^[A-Z]{2}$',
    },
    timezone: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.timezone,
      pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
    },
    currency: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.currency,
      pattern: '^[A-Z]{3}$',
    },
    propertyType: {
      type: 'string',
      enum: ['apartment', 'bungalow', 'cabin', 'cottage', 'house', 'studio', 'villa'],
    },
    bedroomCount: {
      type: 'integer',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.bedroomCount,
    },
    bedConfiguration: {
      type: 'array',
      minItems: PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.bedConfiguration.minItems,
      maxItems: PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.bedConfiguration.maxItems,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'quantity'],
        properties: {
          type: {
            type: 'string',
            enum: ['bunk', 'double', 'king', 'queen', 'single', 'sofa-bed'],
          },
          quantity: {
            type: 'integer',
            ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.bedConfiguration.items.properties.quantity,
          },
        },
      },
    },
    bathroomCount: {
      type: 'integer',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.bathroomCount,
    },
    maximumGuests: {
      type: 'integer',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.maximumGuests,
    },
    amenities: {
      type: 'array',
      maxItems: PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.amenities.maxItems,
      items: {
        type: 'string',
        ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.amenities.items,
        pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
      },
    },
    hostNotes: {
      type: 'string',
      ...PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.hostNotes,
      pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
    },
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
    propertyId: identifierSchema,
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
    propertyId: identifierSchema,
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
          amountMinor: {
            type: 'integer',
            minimum: 0,
            maximum: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
          },
          source: { type: 'string', enum: ['base', 'seasonal_override'] },
        },
      },
    },
    nightlySubtotalMinor: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
    cleaningFeeMinor: {
      type: 'integer',
      minimum: 0,
      maximum: PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
    },
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
    guestName: { type: 'string', ...PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1.guestName },
    guestEmail: {
      type: 'string',
      format: 'email',
      minLength: 1,
      maxLength: 254,
      pattern: PUBLIC_NONBLANK_CONTROL_SAFE_TEXT_PATTERN_V1,
    },
    message: { type: 'string', ...PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1.message },
  },
} as const satisfies Record<string, unknown>;

const requestResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicRequestToBookV1.required,
  properties: {
    id: identifierSchema,
    propertyId: identifierSchema,
    arrival: { type: 'string', format: 'date' },
    departure: { type: 'string', format: 'date' },
    nights: { type: 'integer', minimum: 1, maximum: 3660 },
    guestCount: { type: 'integer', minimum: 1, maximum: 200 },
    status: { type: 'string', enum: PUBLIC_BOOKING_REQUEST_STATUSES_V1 },
    quote: { $ref: '#/components/schemas/PublicQuoteV1' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const satisfies Record<string, unknown>;

const validationIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.schemas.PublicValidationIssueV1.required,
  properties: {
    field: {
      type: 'string',
      ...PUBLIC_VALIDATION_ISSUE_BOUNDS_V1.field,
      pattern: PUBLIC_VALIDATION_ISSUE_FIELD_PATTERN_V1,
    },
    code: { type: 'string', enum: PUBLIC_VALIDATION_CODES_V1 },
    message: {
      type: 'string',
      ...PUBLIC_VALIDATION_ISSUE_BOUNDS_V1.message,
      pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
    },
  },
} as const satisfies Record<string, unknown>;

function createErrorResponseSchema(errorCodes: readonly PublicApiErrorCodeV1[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: errorCodes },
          message: {
            type: 'string',
            ...PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1,
            pattern: PUBLIC_BOUNDED_TEXT_PATTERN_V1,
          },
          details: {
            type: 'array',
            items: { $ref: '#/components/schemas/PublicValidationIssueV1' },
          },
        },
      },
    },
  } as const satisfies Record<string, unknown>;
}

const errorResponseSchema = createErrorResponseSchema(PUBLIC_API_ERROR_CODES_V1);

function errorResponse(description: string, errorCodes: readonly PublicApiErrorCodeV1[]) {
  return {
    description,
    content: {
      'application/json': { schema: createErrorResponseSchema(errorCodes) },
    },
  } as const;
}

export const PUBLIC_BOOKING_OPENAPI_V1: PublicOpenApiDocumentV1 = deepFreezeV1({
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
          '400': errorResponse(
            'Invalid property identifier (validation_failed).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.errorCodesByStatus[400],
          ),
          '404': errorResponse(
            'Property not found.',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.errorCodesByStatus[404],
          ),
          '500': errorResponse(
            'Internal server error (internal_error).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.errorCodesByStatus[500],
          ),
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
          '400': errorResponse(
            'Invalid stay.',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.errorCodesByStatus[400],
          ),
          '404': errorResponse(
            'Property not found (property_not_found).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.errorCodesByStatus[404],
          ),
          '500': errorResponse(
            'Internal server error (internal_error).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.errorCodesByStatus[500],
          ),
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
          '400': errorResponse(
            'Invalid stay.',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.errorCodesByStatus[400],
          ),
          '404': errorResponse(
            'Property not found (property_not_found) or quote unavailable (quote_unavailable).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.errorCodesByStatus[404],
          ),
          '500': errorResponse(
            'Internal server error (internal_error).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.errorCodesByStatus[500],
          ),
        },
      },
    },
    [PUBLIC_BOOKING_PATHS_V1.requestToBook]: {
      post: {
        operationId: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.operationId,
        description:
          'Creates a pending request. An idempotent replay returns the existing request with its current lifecycle status.',
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
            description:
              'New pending request or current state of an existing request after an idempotent replay.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicRequestToBookV1' },
              },
            },
          },
          '400': errorResponse(
            'Invalid request.',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.errorCodesByStatus[400],
          ),
          '404': errorResponse(
            'Property not found (property_not_found) or quote unavailable (quote_unavailable).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.errorCodesByStatus[404],
          ),
          '409': errorResponse(
            'The requested stay is unavailable or the request conflicts with existing state.',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.errorCodesByStatus[409],
          ),
          '500': errorResponse(
            'Internal server error (internal_error).',
            PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.errorCodesByStatus[500],
          ),
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
        schema: identifierSchema,
      },
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: {
          type: 'string',
          minLength: PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1.idempotencyKey.minLength,
          maxLength: PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1.idempotencyKey.maxLength,
          pattern: PUBLIC_IDEMPOTENCY_KEY_PATTERN_V1,
        },
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
      PublicValidationIssueV1: validationIssueSchema,
      PublicApiErrorResponseV1: errorResponseSchema,
    },
  },
});

// Keep these imports in the contract package typechecked as consumer-facing names.
export type PublicOpenApiContractTypesV1 = {
  readonly version: PublicApiVersionV1;
  readonly property: PublicPropertyV1;
  readonly request: PublicRequestToBookV1;
};
