import {
  LotusBookingApiErrorV1,
  PublicContractValidationErrorV1,
  PUBLIC_API_VERSION_V1,
  validatePublicAvailabilityRequestV1,
  validatePublicPropertyIdV1,
  validatePublicRequestToBookV1,
  validatePublicIdempotencyKeyV1,
  validatePublicQuoteRequestV1,
  type PublicApiErrorV1,
  type PublicApiErrorCodeV1,
  type PublicAvailabilityRequestV1,
  type PublicAvailabilityV1,
  type PublicPropertyV1,
  type PublicQuoteRequestV1,
  type PublicQuoteV1,
  type PublicRequestToBookInputV1,
  type PublicRequestToBookOptionsV1,
  type PublicRequestToBookV1,
} from './public-contract-v1.js';
import {
  PUBLIC_BOOKING_CONTRACT_MANIFEST_V1,
  publicBookingPathV1,
  type PublicBookingOperationKeyV1,
} from './contract-manifest-v1.js';

export interface PublicFetchResponseV1 {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface PublicFetchInitV1 {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type PublicFetchV1 = (
  url: string,
  init: PublicFetchInitV1,
) => Promise<PublicFetchResponseV1>;

export interface LotusBookingClientOptionsV1 {
  readonly baseUrl: string;
  readonly fetch?: PublicFetchV1;
  readonly defaultPropertyId?: string;
}

/** Public consumer contract. Apps must depend on this boundary, not server internals. */
export interface LotusBookingClientV1 {
  readonly apiVersion: typeof PUBLIC_API_VERSION_V1;
  getPublicProperty(): Promise<PublicPropertyV1>;
  getPublicProperty(propertyId: string): Promise<PublicPropertyV1>;
  getProperty(propertyId: string): Promise<PublicPropertyV1>;
  getAvailability(
    propertyId: string,
    input: PublicAvailabilityRequestV1,
  ): Promise<PublicAvailabilityV1>;
  getQuote(propertyId: string, input: PublicQuoteRequestV1): Promise<PublicQuoteV1>;
  requestToBook(
    propertyId: string,
    input: PublicRequestToBookInputV1,
    options?: PublicRequestToBookOptionsV1,
  ): Promise<PublicRequestToBookV1>;
}

function defaultFetch(url: string, init: PublicFetchInitV1): Promise<PublicFetchResponseV1> {
  if (typeof globalThis.fetch !== 'function') {
    return Promise.reject(new Error('A fetch implementation is required by the public SDK.'));
  }
  return globalThis.fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

function validatePropertyId(propertyId: string): void {
  const result = validatePublicPropertyIdV1(propertyId);
  if (!result.ok) {
    throw new PublicContractValidationErrorV1(result.errors);
  }
}

function validateStay(input: unknown, validator: typeof validatePublicAvailabilityRequestV1): void {
  const result = validator(input);
  if (!result.ok) {
    throw new PublicContractValidationErrorV1(result.errors);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

const PUBLIC_PROPERTY_TYPES_V1 = [
  'apartment',
  'bungalow',
  'cabin',
  'cottage',
  'house',
  'studio',
  'villa',
] as const;

const PUBLIC_BED_TYPES_V1 = ['bunk', 'double', 'king', 'queen', 'single', 'sofa-bed'] as const;

function isPublicPropertyType(value: unknown): value is PublicPropertyV1['propertyType'] {
  return (
    typeof value === 'string' &&
    PUBLIC_PROPERTY_TYPES_V1.includes(value as (typeof PUBLIC_PROPERTY_TYPES_V1)[number])
  );
}

function isPublicBedType(
  value: unknown,
): value is PublicPropertyV1['bedConfiguration'][number]['type'] {
  return (
    typeof value === 'string' &&
    PUBLIC_BED_TYPES_V1.includes(value as (typeof PUBLIC_BED_TYPES_V1)[number])
  );
}

function isPublicProperty(value: unknown): value is PublicPropertyV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    typeof value['id'] !== 'string' ||
    typeof value['name'] !== 'string' ||
    typeof value['summary'] !== 'string' ||
    typeof value['country'] !== 'string' ||
    typeof value['timezone'] !== 'string' ||
    typeof value['currency'] !== 'string' ||
    !isPublicPropertyType(value['propertyType']) ||
    typeof value['bedroomCount'] !== 'number' ||
    typeof value['bathroomCount'] !== 'number' ||
    typeof value['maximumGuests'] !== 'number' ||
    typeof value['hostNotes'] !== 'string' ||
    !Array.isArray(value['bedConfiguration']) ||
    !Array.isArray(value['amenities']) ||
    value['amenities'].some((amenity) => typeof amenity !== 'string')
  ) {
    return false;
  }
  return value['bedConfiguration'].every(
    (bed) =>
      isRecord(bed) &&
      hasExactKeys(bed, ['type', 'quantity']) &&
      isPublicBedType(bed['type']) &&
      typeof bed['quantity'] === 'number',
  );
}

function isPublicStay(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['arrival'] === 'string' &&
    typeof value['departure'] === 'string' &&
    typeof value['nights'] === 'number'
  );
}

function isPublicAvailability(value: unknown): value is PublicAvailabilityV1 {
  return (
    isRecord(value) &&
    isPublicStay(value) &&
    hasExactKeys(value, ['propertyId', 'arrival', 'departure', 'nights', 'available']) &&
    typeof value['propertyId'] === 'string' &&
    typeof value['available'] === 'boolean'
  );
}

function isPublicQuote(value: unknown): value is PublicQuoteV1 {
  if (
    !isRecord(value) ||
    !isPublicStay(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    typeof value['propertyId'] !== 'string' ||
    typeof value['currency'] !== 'string' ||
    typeof value['nightlySubtotalMinor'] !== 'number' ||
    typeof value['cleaningFeeMinor'] !== 'number' ||
    typeof value['totalMinor'] !== 'number' ||
    typeof value['minimumStayNights'] !== 'number' ||
    !Array.isArray(value['nightly'])
  ) {
    return false;
  }
  return value['nightly'].every(
    (night) =>
      isRecord(night) &&
      hasExactKeys(night, ['date', 'amountMinor', 'source']) &&
      typeof night['date'] === 'string' &&
      typeof night['amountMinor'] === 'number' &&
      (night['source'] === 'base' || night['source'] === 'seasonal_override'),
  );
}

function isPublicRequestToBook(value: unknown): value is PublicRequestToBookV1 {
  return (
    isRecord(value) &&
    isPublicStay(value) &&
    hasExactKeys(value, [
      'id',
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'guestCount',
      'status',
      'quote',
      'createdAt',
    ]) &&
    typeof value['id'] === 'string' &&
    typeof value['propertyId'] === 'string' &&
    typeof value['guestCount'] === 'number' &&
    (value['status'] === 'pending' ||
      value['status'] === 'approved' ||
      value['status'] === 'rejected' ||
      value['status'] === 'expired') &&
    isPublicQuote(value['quote']) &&
    typeof value['createdAt'] === 'string'
  );
}

function decodePublicResponse<T>(
  status: number,
  body: unknown,
  guard: (value: unknown) => value is T,
): T {
  if (!guard(body)) {
    throw new LotusBookingApiErrorV1(status, {
      code: 'internal_error',
      message: 'The public API returned an invalid response.',
    });
  }
  return body;
}

const PUBLIC_ERROR_CODES_V1: readonly PublicApiErrorCodeV1[] = [
  'validation_failed',
  'property_not_found',
  'quote_unavailable',
  'stay_unavailable',
  'request_conflict',
  'route_not_found',
  'method_not_allowed',
  'internal_error',
];

function decodeError(status: number, body: unknown): LotusBookingApiErrorV1 {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error &&
    'message' in body.error &&
    typeof body.error.code === 'string' &&
    typeof body.error.message === 'string' &&
    PUBLIC_ERROR_CODES_V1.includes(body.error.code as PublicApiErrorCodeV1)
  ) {
    const rawError = body.error as {
      readonly code: string;
      readonly message: string;
      readonly details?: unknown;
    };
    const publicError: PublicApiErrorV1 =
      rawError.details === undefined
        ? {
            code: rawError.code as PublicApiErrorV1['code'],
            message: rawError.message,
          }
        : {
            code: rawError.code as PublicApiErrorV1['code'],
            message: rawError.message,
            details: rawError.details as NonNullable<PublicApiErrorV1['details']>,
          };
    return new LotusBookingApiErrorV1(status, publicError);
  }
  return new LotusBookingApiErrorV1(status, {
    code: 'internal_error',
    message: 'The public API returned an invalid error response.',
  });
}

export function createLotusBookingClientV1(
  options: LotusBookingClientOptionsV1,
): LotusBookingClientV1 {
  const baseUrl = options.baseUrl.trim();
  if (baseUrl.length === 0) {
    throw new TypeError('Public SDK baseUrl must not be empty.');
  }
  const fetcher = options.fetch ?? defaultFetch;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    guard?: (value: unknown) => value is T,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    const response = await fetcher(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...extraHeaders,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody = await response.json();
    if (!response.ok) {
      throw decodeError(response.status, responseBody);
    }
    return guard === undefined
      ? (responseBody as T)
      : decodePublicResponse(response.status, responseBody, guard);
  }

  function propertyPath(
    propertyId: string,
    operation: PublicBookingOperationKeyV1 = 'property',
  ): string {
    validatePropertyId(propertyId);
    return publicBookingPathV1(operation, propertyId);
  }

  async function getProperty(propertyId: string): Promise<PublicPropertyV1> {
    return request<PublicPropertyV1>(
      PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.property.method,
      propertyPath(propertyId),
      undefined,
      isPublicProperty,
    );
  }

  return {
    apiVersion: PUBLIC_API_VERSION_V1,
    getPublicProperty(propertyId?: string): Promise<PublicPropertyV1> {
      const resolvedId = propertyId ?? options.defaultPropertyId;
      if (resolvedId === undefined) {
        throw new TypeError('A propertyId or defaultPropertyId is required.');
      }
      return getProperty(resolvedId);
    },
    getProperty,
    async getAvailability(
      propertyId: string,
      input: PublicAvailabilityRequestV1,
    ): Promise<PublicAvailabilityV1> {
      validateStay(input, validatePublicAvailabilityRequestV1);
      const query = new URLSearchParams({ arrival: input.arrival, departure: input.departure });
      return request<PublicAvailabilityV1>(
        PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.availability.method,
        `${propertyPath(propertyId, 'availability')}?${query.toString()}`,
        undefined,
        isPublicAvailability,
      );
    },
    async getQuote(propertyId: string, input: PublicQuoteRequestV1): Promise<PublicQuoteV1> {
      validateStay(input, validatePublicQuoteRequestV1);
      return request<PublicQuoteV1>(
        PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.quote.method,
        propertyPath(propertyId, 'quote'),
        input,
        isPublicQuote,
      );
    },
    async requestToBook(
      propertyId: string,
      input: PublicRequestToBookInputV1,
      options: PublicRequestToBookOptionsV1,
    ): Promise<PublicRequestToBookV1> {
      const result = validatePublicRequestToBookV1(input);
      if (!result.ok) {
        throw new PublicContractValidationErrorV1(result.errors);
      }
      const keyResult = validatePublicIdempotencyKeyV1(options.idempotencyKey);
      if (!keyResult.ok) {
        throw new PublicContractValidationErrorV1(keyResult.errors);
      }
      const idempotencyKey = keyResult.value;
      return request<PublicRequestToBookV1>(
        PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.method,
        propertyPath(propertyId, 'requestToBook'),
        input,
        isPublicRequestToBook,
        { 'Idempotency-Key': idempotencyKey },
      );
    },
  };
}
