import {
  PublicContractValidationErrorV1,
  PUBLIC_API_VERSION_V1,
  validatePublicAvailabilityRequestV1,
  validatePublicPropertyIdV1,
  validatePublicRequestToBookV1,
  validatePublicIdempotencyKeyV1,
  validatePublicQuoteRequestV1,
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
import {
  PUBLIC_RESPONSE_DECODERS_V1,
  readPublicResponseV1,
  type PublicResponseDecoderContextV1,
} from './response-decoder-v1.js';

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

export interface BookingEngineClientOptionsV1 {
  readonly baseUrl: string;
  readonly fetch?: PublicFetchV1;
  readonly defaultPropertyId?: string;
}

/** Public consumer contract. Apps must depend on this boundary, not server internals. */
export interface BookingEngineClientV1 {
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
    options: PublicRequestToBookOptionsV1,
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

export function createBookingEngineClientV1(
  options: BookingEngineClientOptionsV1,
): BookingEngineClientV1 {
  const baseUrl = options.baseUrl.trim();
  if (baseUrl.length === 0) {
    throw new TypeError('Public SDK baseUrl must not be empty.');
  }
  const fetcher = options.fetch ?? defaultFetch;

  async function request<T>(
    context: PublicResponseDecoderContextV1,
    path: string,
    body: unknown | undefined,
    guard: (value: unknown) => value is T,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
    const response = await fetcher(url, {
      method: PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations[context.operation].method,
      headers: {
        Accept: 'application/json',
        ...extraHeaders,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return readPublicResponseV1(response, guard, context);
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
      { operation: 'property', propertyId },
      propertyPath(propertyId),
      undefined,
      PUBLIC_RESPONSE_DECODERS_V1.property,
    );
  }

  return {
    apiVersion: PUBLIC_API_VERSION_V1,
    getPublicProperty(propertyId?: string): Promise<PublicPropertyV1> {
      const resolvedId = propertyId ?? options.defaultPropertyId;
      if (resolvedId === undefined) {
        return Promise.reject(new TypeError('A propertyId or defaultPropertyId is required.'));
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
        {
          operation: 'availability',
          propertyId,
          arrival: input.arrival,
          departure: input.departure,
        },
        `${propertyPath(propertyId, 'availability')}?${query.toString()}`,
        undefined,
        PUBLIC_RESPONSE_DECODERS_V1.availability,
      );
    },
    async getQuote(propertyId: string, input: PublicQuoteRequestV1): Promise<PublicQuoteV1> {
      validateStay(input, validatePublicQuoteRequestV1);
      return request<PublicQuoteV1>(
        {
          operation: 'quote',
          propertyId,
          arrival: input.arrival,
          departure: input.departure,
        },
        propertyPath(propertyId, 'quote'),
        input,
        PUBLIC_RESPONSE_DECODERS_V1.quote,
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
      const idempotencyKeyValue = options?.idempotencyKey;
      if (idempotencyKeyValue === undefined) {
        throw new PublicContractValidationErrorV1([
          {
            field: 'idempotencyKey',
            code: 'missing_field',
            message: 'idempotencyKey is required for request-to-book.',
          },
        ]);
      }
      const keyResult = validatePublicIdempotencyKeyV1(idempotencyKeyValue);
      if (!keyResult.ok) {
        throw new PublicContractValidationErrorV1(keyResult.errors);
      }
      const idempotencyKey = keyResult.value;
      return request<PublicRequestToBookV1>(
        {
          operation: 'requestToBook',
          propertyId,
          arrival: input.arrival,
          departure: input.departure,
          guestCount: input.guestCount,
        },
        propertyPath(propertyId, 'requestToBook'),
        input,
        PUBLIC_RESPONSE_DECODERS_V1.requestToBook,
        { 'Idempotency-Key': idempotencyKey },
      );
    },
  };
}
