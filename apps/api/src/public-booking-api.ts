import { randomUUID } from 'node:crypto';

import type {
  AvailabilityRepository,
  BookingRequestCreateInputV1,
  BookingRequestRecordV1,
  BookingRequestRepositoryV1,
  OrganizationScope,
  PropertyRepository,
  RateRepository,
} from '@lotus-booking/database-postgres';
import type { QuoteBreakdownV1, PropertyConfigurationV1 } from '@lotus-booking/booking-core';
import type {
  PublicApiErrorCodeV1,
  PublicApiErrorResponseV1,
  PublicAvailabilityV1,
  PublicPropertyV1,
  PublicQuoteV1,
  PublicRequestToBookV1,
  PublicStayV1,
  PublicValidationCodeV1,
  PublicValidationIssueV1,
} from '@lotus-booking/sdk-typescript';
import { PUBLIC_BOOKING_PATHS_V1 } from '@lotus-booking/sdk-typescript';
import {
  validatePublicPropertyIdV1,
  validatePublicIdempotencyKeyV1,
  validatePublicRequestToBookV1,
  validatePublicStayV1,
} from '@lotus-booking/sdk-typescript';

export type PublicBookingScopeV1 = OrganizationScope;

export type PublicBookingRequestRepositoryV1 = Pick<BookingRequestRepositoryV1, 'submit'>;

export interface PublicBookingApiDependenciesV1 {
  readonly properties: Pick<PropertyRepository, 'findPublicById'>;
  readonly availability: Pick<AvailabilityRepository, 'isAvailable'>;
  readonly rates: Pick<RateRepository, 'quote'>;
  readonly bookingRequests: PublicBookingRequestRepositoryV1;
}

export interface PublicHttpRequestV1 {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface PublicHttpResponseV1 {
  readonly status: number;
  readonly body: unknown;
}

export class PublicBookingApiErrorV1 extends Error {
  readonly status: number;
  readonly code: PublicApiErrorCodeV1;
  readonly details: readonly PublicValidationIssueV1[] | undefined;

  constructor(
    status: number,
    code: PublicApiErrorCodeV1,
    message: string,
    details?: readonly PublicValidationIssueV1[],
  ) {
    super(message);
    this.name = 'PublicBookingApiErrorV1';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response(): PublicApiErrorResponseV1 {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const PublicApiErrorV1 = PublicBookingApiErrorV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPersistenceError(value: unknown): value is {
  readonly code: string;
  readonly errors?: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
} {
  return isRecord(value) && typeof value['code'] === 'string';
}

function publicValidationCode(code: string): PublicValidationCodeV1 {
  const knownCodes: readonly PublicValidationCodeV1[] = [
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
  ];
  return knownCodes.includes(code as PublicValidationCodeV1)
    ? (code as PublicValidationCodeV1)
    : 'invalid_value';
}

function validationDetails(
  errors:
    | readonly { readonly field: string; readonly code: string; readonly message: string }[]
    | undefined,
): readonly PublicValidationIssueV1[] | undefined {
  if (errors === undefined) {
    return undefined;
  }
  return errors.map(({ field, code, message }) => ({
    field,
    code: publicValidationCode(code),
    message,
  }));
}

function mapPersistenceError(error: unknown): PublicBookingApiErrorV1 {
  if (!isPersistenceError(error)) {
    return new PublicBookingApiErrorV1(
      500,
      'internal_error',
      'The public API could not complete the request.',
    );
  }
  switch (error.code) {
    case 'property_not_found':
      return new PublicBookingApiErrorV1(404, 'property_not_found', 'Property was not found.');
    case 'rate_plan_not_found':
      return new PublicBookingApiErrorV1(
        404,
        'quote_unavailable',
        'A quote is not available for this property.',
      );
    case 'invalid_stay':
    case 'rate_validation':
    case 'booking_request_validation':
      return new PublicBookingApiErrorV1(
        400,
        'validation_failed',
        'Request validation failed.',
        validationDetails(error.errors),
      );
    case 'availability_conflict':
      return new PublicBookingApiErrorV1(
        409,
        'stay_unavailable',
        'The requested stay is not available.',
      );
    case 'duplicate_booking_request':
    case 'idempotency_key_reuse':
      return new PublicBookingApiErrorV1(
        409,
        'request_conflict',
        'The booking request could not be accepted.',
      );
    case 'invalid_organization_id':
    case 'invalid_property_id':
      return new PublicBookingApiErrorV1(404, 'property_not_found', 'Property was not found.');
    default:
      return new PublicBookingApiErrorV1(
        500,
        'internal_error',
        'The public API could not complete the request.',
      );
  }
}

function throwValidation(result: {
  readonly ok: false;
  readonly errors: readonly PublicValidationIssueV1[];
}): never {
  throw new PublicBookingApiErrorV1(
    400,
    'validation_failed',
    'Request validation failed.',
    result.errors,
  );
}

function requirePropertyId(propertyId: string): string {
  const result = validatePublicPropertyIdV1(propertyId);
  if (!result.ok) {
    throwValidation(result);
  }
  return result.value;
}

function idempotencyKeyHeader(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key');
  return entry?.[1];
}

function publicProperty(property: PublicPropertyV1): PublicPropertyV1 {
  return Object.freeze({
    id: property.id,
    name: property.name,
    summary: property.summary,
    country: property.country,
    timezone: property.timezone,
    currency: property.currency,
    propertyType: property.propertyType,
    bedroomCount: property.bedroomCount,
    bedConfiguration: Object.freeze(
      property.bedConfiguration.map((bed) =>
        Object.freeze({ type: bed.type, quantity: bed.quantity }),
      ),
    ),
    bathroomCount: property.bathroomCount,
    maximumGuests: property.maximumGuests,
    amenities: Object.freeze([...property.amenities]),
    hostNotes: property.hostNotes,
  });
}

export function serializePublicPropertyResponseV1(
  property: PublicPropertyV1 | PropertyConfigurationV1,
): PublicPropertyV1 {
  return publicProperty(property);
}

export function serializePublicAvailabilityV1(
  propertyId: string,
  stay: PublicStayV1,
  available: boolean,
): PublicAvailabilityV1 {
  return Object.freeze({
    propertyId,
    arrival: stay.arrival,
    departure: stay.departure,
    nights: stay.nights,
    available,
  });
}

export function serializePublicQuoteV1(propertyId: string, quote: QuoteBreakdownV1): PublicQuoteV1 {
  return Object.freeze({
    propertyId,
    arrival: quote.arrival,
    departure: quote.departure,
    nights: quote.nights,
    currency: quote.currency,
    nightly: Object.freeze(
      quote.nightly.map((night) =>
        Object.freeze({ date: night.date, amountMinor: night.amountMinor, source: night.source }),
      ),
    ),
    nightlySubtotalMinor: quote.nightlySubtotalMinor,
    cleaningFeeMinor: quote.cleaningFeeMinor,
    totalMinor: quote.totalMinor,
    minimumStayNights: quote.minimumStayNights,
  });
}

export function serializePublicBookingRequestV1(
  request: BookingRequestRecordV1,
): PublicRequestToBookV1 {
  return Object.freeze({
    id: request.id,
    propertyId: request.propertyId,
    arrival: request.arrival,
    departure: request.departure,
    nights: request.quote.nights,
    guestCount: request.guestCount,
    status: request.status,
    quote: serializePublicQuoteV1(request.propertyId, request.quote),
    createdAt: request.createdAt,
  });
}

function ensureProperty(
  dependencies: PublicBookingApiDependenciesV1,
  scope: PublicBookingScopeV1,
  propertyId: string,
): Promise<PublicPropertyV1> {
  return dependencies.properties
    .findPublicById(scope, propertyId)
    .then((property) => {
      if (property === null) {
        throw new PublicBookingApiErrorV1(404, 'property_not_found', 'Property was not found.');
      }
      return publicProperty(property);
    })
    .catch((error: unknown) => {
      if (error instanceof PublicBookingApiErrorV1) {
        throw error;
      }
      throw mapPersistenceError(error);
    });
}

export interface PublicBookingApiV1 {
  getProperty(scope: PublicBookingScopeV1, propertyId: string): Promise<PublicPropertyV1>;
  getAvailability(
    scope: PublicBookingScopeV1,
    propertyId: string,
    input: unknown,
  ): Promise<PublicAvailabilityV1>;
  getQuote(scope: PublicBookingScopeV1, propertyId: string, input: unknown): Promise<PublicQuoteV1>;
  requestToBook(
    scope: PublicBookingScopeV1,
    propertyId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<PublicRequestToBookV1>;
}

export function createPublicBookingApiV1(
  dependencies: PublicBookingApiDependenciesV1,
): PublicBookingApiV1 {
  return {
    async getProperty(scope, propertyId): Promise<PublicPropertyV1> {
      const id = requirePropertyId(propertyId);
      return ensureProperty(dependencies, scope, id);
    },
    async getAvailability(scope, propertyId, input): Promise<PublicAvailabilityV1> {
      const id = requirePropertyId(propertyId);
      const stay = validatePublicStayV1(input);
      if (!stay.ok) {
        throwValidation(stay);
      }
      await ensureProperty(dependencies, scope, id);
      try {
        const available = await dependencies.availability.isAvailable(scope, id, stay.value);
        return serializePublicAvailabilityV1(id, stay.value, available);
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async getQuote(scope, propertyId, input): Promise<PublicQuoteV1> {
      const id = requirePropertyId(propertyId);
      const stay = validatePublicStayV1(input);
      if (!stay.ok) {
        throwValidation(stay);
      }
      await ensureProperty(dependencies, scope, id);
      try {
        const quote = await dependencies.rates.quote(scope, id, {
          arrival: stay.value.arrival,
          departure: stay.value.departure,
        });
        return serializePublicQuoteV1(id, quote);
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async requestToBook(scope, propertyId, input, idempotencyKey): Promise<PublicRequestToBookV1> {
      if (typeof dependencies.bookingRequests.submit !== 'function') {
        throw new PublicBookingApiErrorV1(
          500,
          'internal_error',
          'The public API could not complete the request.',
        );
      }
      const id = requirePropertyId(propertyId);
      const request = validatePublicRequestToBookV1(input);
      if (!request.ok) {
        throwValidation(request);
      }
      if (idempotencyKey === undefined) {
        throwValidation({
          ok: false,
          errors: [
            {
              field: 'idempotencyKey',
              code: 'missing_field',
              message: 'idempotencyKey is required for request-to-book.',
            },
          ],
        });
      }
      const keyResult = validatePublicIdempotencyKeyV1(idempotencyKey);
      if (!keyResult.ok) {
        throwValidation(keyResult);
      }
      const validatedIdempotencyKey = keyResult.value;
      const property = await ensureProperty(dependencies, scope, id);
      if (request.value.guestCount > property.maximumGuests) {
        throw new PublicBookingApiErrorV1(400, 'validation_failed', 'Request validation failed.', [
          {
            field: 'guestCount',
            code: 'invalid_value',
            message: `guestCount must not exceed this property's maximum of ${property.maximumGuests}.`,
          },
        ]);
      }
      try {
        const quote = await dependencies.rates.quote(scope, id, {
          arrival: request.value.arrival,
          departure: request.value.departure,
        });
        const createInput: BookingRequestCreateInputV1 = {
          id: randomUUID(),
          arrival: request.value.arrival,
          departure: request.value.departure,
          guestCount: request.value.guestCount,
          guestName: request.value.guestName,
          guestEmail: request.value.guestEmail,
          message: request.value.message ?? null,
          quote,
        };
        const saved = await dependencies.bookingRequests.submit(scope, id, createInput, {
          idempotencyKey: validatedIdempotencyKey,
          deferInventory: true,
        });
        return serializePublicBookingRequestV1(saved);
      } catch (error) {
        if (error instanceof PublicBookingApiErrorV1) {
          throw error;
        }
        throw mapPersistenceError(error);
      }
    },
  };
}

function routeParts(path: string):
  | {
      readonly resource: 'property' | 'availability' | 'quote' | 'requestToBook';
      readonly propertyId: string;
      readonly url: URL;
    }
  | undefined {
  let url: URL;
  try {
    url = new URL(path, 'https://lotus-booking.invalid');
  } catch {
    return undefined;
  }
  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length < 3 || parts[0] !== 'v1' || parts[1] !== 'properties') {
    return undefined;
  }
  let propertyId: string;
  try {
    propertyId = decodeURIComponent(parts[2] as string);
  } catch {
    return undefined;
  }
  const encodedPropertyId = encodeURIComponent(propertyId);
  const paths = {
    property: PUBLIC_BOOKING_PATHS_V1.property.replace('{propertyId}', encodedPropertyId),
    availability: PUBLIC_BOOKING_PATHS_V1.availability.replace('{propertyId}', encodedPropertyId),
    quote: PUBLIC_BOOKING_PATHS_V1.quote.replace('{propertyId}', encodedPropertyId),
    requestToBook: PUBLIC_BOOKING_PATHS_V1.requestToBook.replace('{propertyId}', encodedPropertyId),
  };
  if (url.pathname === paths.property) {
    return { resource: 'property', propertyId, url };
  }
  if (url.pathname === paths.availability) {
    return { resource: 'availability', propertyId, url };
  }
  if (url.pathname === paths.quote) {
    return { resource: 'quote', propertyId, url };
  }
  if (url.pathname === paths.requestToBook) {
    return { resource: 'requestToBook', propertyId, url };
  }
  return undefined;
}

function errorResponse(error: unknown): PublicHttpResponseV1 {
  if (error instanceof PublicBookingApiErrorV1) {
    return { status: error.status, body: error.response() };
  }
  return {
    status: 500,
    body: {
      error: { code: 'internal_error', message: 'The public API could not complete the request.' },
    } satisfies PublicApiErrorResponseV1,
  };
}

export interface PublicBookingHttpApiV1 {
  handle(scope: PublicBookingScopeV1, request: PublicHttpRequestV1): Promise<PublicHttpResponseV1>;
}

export function createPublicBookingHttpApiV1(
  dependencies: PublicBookingApiDependenciesV1,
): PublicBookingHttpApiV1 {
  const api = createPublicBookingApiV1(dependencies);
  return {
    async handle(scope, request): Promise<PublicHttpResponseV1> {
      const route = routeParts(request.path);
      if (route === undefined) {
        return errorResponse(
          new PublicBookingApiErrorV1(404, 'route_not_found', 'Public route was not found.'),
        );
      }
      try {
        if (route.resource === 'property') {
          if (request.method !== 'GET') {
            throw new PublicBookingApiErrorV1(
              405,
              'method_not_allowed',
              'Method is not allowed for this route.',
            );
          }
          return { status: 200, body: await api.getProperty(scope, route.propertyId) };
        }
        if (route.resource === 'availability') {
          if (request.method !== 'GET') {
            throw new PublicBookingApiErrorV1(
              405,
              'method_not_allowed',
              'Method is not allowed for this route.',
            );
          }
          return {
            status: 200,
            body: await api.getAvailability(scope, route.propertyId, {
              arrival: route.url.searchParams.get('arrival') ?? undefined,
              departure: route.url.searchParams.get('departure') ?? undefined,
            }),
          };
        }
        if (request.method !== 'POST') {
          throw new PublicBookingApiErrorV1(
            405,
            'method_not_allowed',
            'Method is not allowed for this route.',
          );
        }
        if (route.resource === 'quote') {
          return { status: 200, body: await api.getQuote(scope, route.propertyId, request.body) };
        }
        return {
          status: 201,
          body: await api.requestToBook(
            scope,
            route.propertyId,
            request.body,
            idempotencyKeyHeader(request.headers),
          ),
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
