import { randomUUID } from 'node:crypto';

import type { BookingRequestCreateInput } from '@booking-engine/database-postgres';
import type {
  PublicAvailabilityV1,
  PublicPropertyV1,
  PublicQuoteV1,
  PublicRequestToBookV1,
} from '@booking-engine/sdk-typescript';
import {
  validatePublicRequestToBookV1,
  validatePublicStayV1,
} from '@booking-engine/sdk-typescript';

import { serializePublicProperty } from '../../property/configuration/mapper.js';
import {
  PublicApiErrorV1,
  PublicBookingApiError,
  type PublicBookingApi,
  type PublicBookingApiDependencies,
  type PublicBookingHttpApi,
  type PublicBookingRequestRepository,
  type PublicBookingScope,
  type PublicHttpRequest,
  type PublicHttpResponse,
} from './contracts.js';
import {
  errorResponse,
  mapPersistenceError,
  requireIdempotencyKey,
  requirePropertyId,
  throwValidation,
} from './errors.js';
import { idempotencyKeyHeader, parsePublicBookingRoute } from './routes.js';
import {
  serializePublicAvailability,
  serializePublicBookingRequest,
  serializePublicQuote,
} from './serialization.js';

function ensureProperty(
  dependencies: PublicBookingApiDependencies,
  scope: PublicBookingScope,
  propertyId: string,
): Promise<PublicPropertyV1> {
  return dependencies.properties
    .findPublicById(scope, propertyId)
    .then((property) => {
      if (property === null) {
        throw new PublicBookingApiError(404, 'property_not_found', 'Property was not found.');
      }
      return serializePublicProperty(property);
    })
    .catch((error: unknown) => {
      if (error instanceof PublicBookingApiError) {
        throw error;
      }
      throw mapPersistenceError(error);
    });
}

function isIdempotencyKeyReuse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'idempotency_key_reuse';
}

export function createPublicBookingApi(
  dependencies: PublicBookingApiDependencies,
): PublicBookingApi {
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
        return serializePublicAvailability(id, stay.value, available);
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
        return serializePublicQuote(id, quote);
      } catch (error) {
        throw mapPersistenceError(error);
      }
    },
    async requestToBook(scope, propertyId, input, idempotencyKey): Promise<PublicRequestToBookV1> {
      if (
        typeof dependencies.bookingRequests.findByIdempotencyKey !== 'function' ||
        typeof dependencies.bookingRequests.submit !== 'function'
      ) {
        throw new PublicBookingApiError(
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
      const validatedIdempotencyKey = requireIdempotencyKey(idempotencyKey);
      const clientInput = {
        arrival: request.value.arrival,
        departure: request.value.departure,
        guestCount: request.value.guestCount,
        guestName: request.value.guestName,
        guestEmail: request.value.guestEmail,
        message: request.value.message ?? null,
      };
      const findReplay = () =>
        dependencies.bookingRequests.findByIdempotencyKey(
          scope,
          id,
          clientInput,
          validatedIdempotencyKey,
        );

      try {
        const replay = await findReplay();
        if (replay !== null) {
          return serializePublicBookingRequest(replay);
        }

        try {
          const property = await ensureProperty(dependencies, scope, id);
          if (request.value.guestCount > property.maximumGuests) {
            throw new PublicBookingApiError(
              400,
              'validation_failed',
              'Request validation failed.',
              [
                {
                  field: 'guestCount',
                  code: 'invalid_value',
                  message: `guestCount must not exceed this property's maximum of ${property.maximumGuests}.`,
                },
              ],
            );
          }
          const quote = await dependencies.rates.quote(scope, id, {
            arrival: request.value.arrival,
            departure: request.value.departure,
          });
          const createInput: BookingRequestCreateInput = {
            id: randomUUID(),
            arrival: request.value.arrival,
            departure: request.value.departure,
            guestCount: request.value.guestCount,
            guestName: request.value.guestName,
            guestEmail: request.value.guestEmail,
            message: request.value.message ?? null,
            quote,
          };
          try {
            const saved = await dependencies.bookingRequests.submit(scope, id, createInput, {
              idempotencyKey: validatedIdempotencyKey,
              deferInventory: true,
            });
            return serializePublicBookingRequest(saved);
          } catch (error) {
            if (!isIdempotencyKeyReuse(error)) {
              throw error;
            }
            const racedReplay = await findReplay();
            if (racedReplay !== null) {
              return serializePublicBookingRequest(racedReplay);
            }
            throw error;
          }
        } catch (error) {
          if (isIdempotencyKeyReuse(error)) {
            throw error;
          }
          try {
            const racedReplay = await findReplay();
            if (racedReplay !== null) {
              return serializePublicBookingRequest(racedReplay);
            }
          } catch (lookupError) {
            if (isIdempotencyKeyReuse(lookupError)) {
              throw lookupError;
            }
          }
          throw error;
        }
      } catch (error) {
        if (error instanceof PublicBookingApiError) {
          throw error;
        }
        throw mapPersistenceError(error);
      }
    },
  };
}

export function createPublicBookingHttpApi(
  dependencies: PublicBookingApiDependencies,
): PublicBookingHttpApi {
  const api = createPublicBookingApi(dependencies);
  return {
    async handle(scope, request: PublicHttpRequest): Promise<PublicHttpResponse> {
      const route = parsePublicBookingRoute(request.path);
      if (route === undefined) {
        return errorResponse(
          new PublicBookingApiError(404, 'route_not_found', 'Public route was not found.'),
        );
      }
      try {
        if (route.resource === 'property') {
          if (request.method !== 'GET') {
            throw new PublicBookingApiError(
              405,
              'method_not_allowed',
              'Method is not allowed for this route.',
            );
          }
          return { status: 200, body: await api.getProperty(scope, route.propertyId) };
        }
        if (route.resource === 'availability') {
          if (request.method !== 'GET') {
            throw new PublicBookingApiError(
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
          throw new PublicBookingApiError(
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

export {
  PublicApiErrorV1,
  PublicBookingApiError,
  serializePublicAvailability,
  serializePublicBookingRequest,
  serializePublicQuote,
};
export type {
  PublicBookingApi,
  PublicBookingApiDependencies,
  PublicBookingHttpApi,
  PublicBookingRequestRepository,
  PublicBookingScope,
  PublicHttpRequest,
  PublicHttpResponse,
};
