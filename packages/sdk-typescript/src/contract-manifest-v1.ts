import type {
  PublicApiErrorResponseV1,
  PublicAvailabilityV1,
  PublicPropertyV1,
  PublicQuoteV1,
  PublicRequestToBookInputV1,
  PublicRequestToBookV1,
  PublicStayInputV1,
  PublicStayV1,
} from './public-contract-v1.js';

const operations = {
  property: {
    method: 'GET',
    path: '/v1/properties/{propertyId}',
    operationId: 'getPublicPropertyV1',
    responseSchema: 'PublicPropertyV1',
  },
  availability: {
    method: 'GET',
    path: '/v1/properties/{propertyId}/availability',
    operationId: 'getPublicAvailabilityV1',
    responseSchema: 'PublicAvailabilityV1',
  },
  quote: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/quote',
    operationId: 'getPublicQuoteV1',
    requestSchema: 'PublicStayInputV1',
    responseSchema: 'PublicQuoteV1',
  },
  requestToBook: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/request-to-book',
    operationId: 'requestToBookV1',
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
  PublicApiErrorResponseV1: {
    fields: ['error'],
    required: ['error'],
  },
} as const;

/** Hand-authored typed SDK metadata used to check routes and schemas against OpenAPI. */
export const PUBLIC_BOOKING_CONTRACT_MANIFEST_V1 = Object.freeze({
  openapiPath: '/openapi/v1.json',
  operations,
  schemas,
});

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
