import {
  deepFreezeV1,
  PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1,
  PUBLIC_VALIDATION_ISSUE_BOUNDS_V1,
} from './contract-constraints-v1.js';
import type {
  PublicApiErrorCodeV1,
  PublicApiErrorResponseV1,
  PublicAvailabilityV1,
  PublicPropertyV1,
  PublicQuoteV1,
  PublicRequestToBookInputV1,
  PublicRequestToBookV1,
  PublicStayInputV1,
  PublicStayV1,
  PublicValidationIssueV1,
} from './public-contract-v1.js';

const operations = {
  property: {
    method: 'GET',
    path: '/v1/properties/{propertyId}',
    operationId: 'getPublicPropertyV1',
    statuses: [200, 400, 404, 500],
    errorCodesByStatus: {
      400: ['validation_failed'],
      404: ['property_not_found'],
      500: ['internal_error'],
    } as const satisfies Readonly<Record<number, readonly PublicApiErrorCodeV1[]>>,
    responseSchema: 'PublicPropertyV1',
  },
  availability: {
    method: 'GET',
    path: '/v1/properties/{propertyId}/availability',
    operationId: 'getPublicAvailabilityV1',
    statuses: [200, 400, 404, 500],
    errorCodesByStatus: {
      400: ['validation_failed'],
      404: ['property_not_found'],
      500: ['internal_error'],
    } as const satisfies Readonly<Record<number, readonly PublicApiErrorCodeV1[]>>,
    responseSchema: 'PublicAvailabilityV1',
  },
  quote: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/quote',
    operationId: 'getPublicQuoteV1',
    statuses: [200, 400, 404, 500],
    errorCodesByStatus: {
      400: ['validation_failed'],
      404: ['property_not_found', 'quote_unavailable'],
      500: ['internal_error'],
    } as const satisfies Readonly<Record<number, readonly PublicApiErrorCodeV1[]>>,
    requestSchema: 'PublicStayInputV1',
    responseSchema: 'PublicQuoteV1',
  },
  requestToBook: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/request-to-book',
    operationId: 'requestToBookV1',
    statuses: [201, 400, 404, 409, 500],
    errorCodesByStatus: {
      400: ['validation_failed'],
      404: ['property_not_found', 'quote_unavailable'],
      409: ['stay_unavailable', 'request_conflict'],
      500: ['internal_error'],
    } as const satisfies Readonly<Record<number, readonly PublicApiErrorCodeV1[]>>,
    requestSchema: 'PublicRequestToBookInputV1',
    responseSchema: 'PublicRequestToBookV1',
  },
} as const;

const schemas = {
  PublicPropertyV1: {
    fields: [
      'id',
      'name',
      'summary',
      'country',
      'timezone',
      'currency',
      'propertyType',
      'bedroomCount',
      'bedConfiguration',
      'bathroomCount',
      'maximumGuests',
      'amenities',
      'hostNotes',
    ],
    required: [
      'id',
      'name',
      'summary',
      'country',
      'timezone',
      'currency',
      'propertyType',
      'bedroomCount',
      'bedConfiguration',
      'bathroomCount',
      'maximumGuests',
      'amenities',
      'hostNotes',
    ],
    bounds: PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1,
  },
  PublicStayInputV1: {
    fields: ['arrival', 'departure'],
    required: ['arrival', 'departure'],
  },
  PublicStayV1: {
    fields: ['arrival', 'departure', 'nights'],
    required: ['arrival', 'departure', 'nights'],
  },
  PublicAvailabilityV1: {
    fields: ['propertyId', 'arrival', 'departure', 'nights', 'available'],
    required: ['propertyId', 'arrival', 'departure', 'nights', 'available'],
  },
  PublicQuoteV1: {
    fields: [
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'currency',
      'nightly',
      'nightlySubtotalMinor',
      'cleaningFeeMinor',
      'totalMinor',
      'minimumStayNights',
    ],
    required: [
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'currency',
      'nightly',
      'nightlySubtotalMinor',
      'cleaningFeeMinor',
      'totalMinor',
      'minimumStayNights',
    ],
  },
  PublicRequestToBookInputV1: {
    fields: ['arrival', 'departure', 'guestCount', 'guestName', 'guestEmail', 'message'],
    required: ['arrival', 'departure', 'guestCount', 'guestName', 'guestEmail'],
  },
  PublicRequestToBookV1: {
    fields: [
      'id',
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'guestCount',
      'status',
      'quote',
      'createdAt',
    ],
    required: [
      'id',
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'guestCount',
      'status',
      'quote',
      'createdAt',
    ],
  },
  PublicValidationIssueV1: {
    fields: ['field', 'code', 'message'],
    required: ['field', 'code', 'message'],
    bounds: PUBLIC_VALIDATION_ISSUE_BOUNDS_V1,
  },
  PublicApiErrorResponseV1: {
    fields: ['error'],
    required: ['error'],
  },
} as const;

/** Hand-authored typed SDK metadata used to check routes and schemas against OpenAPI. */
export const PUBLIC_BOOKING_CONTRACT_MANIFEST_V1 = deepFreezeV1({
  openapiPath: '/openapi/v1.json',
  operations,
  schemas,
} as const);

type EqualV1<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type AssertV1<Value extends true> = Value;

/** These exported checks make a public type field change fail unless the manifest changes too. */
export type PublicBookingManifestTypeChecksV1 = [
  AssertV1<EqualV1<keyof PublicPropertyV1, (typeof schemas.PublicPropertyV1.fields)[number]>>,
  AssertV1<EqualV1<keyof PublicStayInputV1, (typeof schemas.PublicStayInputV1.fields)[number]>>,
  AssertV1<EqualV1<keyof PublicStayV1, (typeof schemas.PublicStayV1.fields)[number]>>,
  AssertV1<
    EqualV1<keyof PublicAvailabilityV1, (typeof schemas.PublicAvailabilityV1.fields)[number]>
  >,
  AssertV1<EqualV1<keyof PublicQuoteV1, (typeof schemas.PublicQuoteV1.fields)[number]>>,
  AssertV1<
    EqualV1<
      keyof PublicRequestToBookInputV1,
      (typeof schemas.PublicRequestToBookInputV1.fields)[number]
    >
  >,
  AssertV1<
    EqualV1<keyof PublicRequestToBookV1, (typeof schemas.PublicRequestToBookV1.fields)[number]>
  >,
  AssertV1<
    EqualV1<keyof PublicValidationIssueV1, (typeof schemas.PublicValidationIssueV1.fields)[number]>
  >,
  AssertV1<
    EqualV1<
      keyof PublicApiErrorResponseV1,
      (typeof schemas.PublicApiErrorResponseV1.fields)[number]
    >
  >,
];

export type PublicBookingOperationKeyV1 = keyof typeof operations;

export function publicBookingPathV1(
  operation: PublicBookingOperationKeyV1,
  propertyId: string,
): string {
  return operations[operation].path.replace('{propertyId}', encodeURIComponent(propertyId));
}
