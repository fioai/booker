import type { AvailabilityRecord, BookingRequestRecord } from '@booking-engine/database-postgres';
import type { PropertyConfiguration, QuoteBreakdown, RatePlan } from '@booking-engine/booking-core';
import type { AdminSessionUser } from './auth.js';
import {
  AdminHttpError,
  type AdminHttpResponse,
  type AdminManualBlockResponse,
  type AdminPageProperty,
  type AdminPropertyResponse,
  type AdminRatePlanResponse,
  type AdminUserResponse,
} from './contracts.js';
import type { ICalSyncHealth } from '../jobs/ical/sync.js';
import { ICAL_SOURCE_ERROR_MESSAGES } from '../jobs/ical/errors.js';

export const SAFE_ERROR_CODES = new Set([
  'invalid_input',
  'missing_field',
  'invalid_string',
  'empty_string',
  'string_too_long',
  'malformed_id',
  'malformed_country',
  'unsupported_country',
  'malformed_currency',
  'unsupported_currency',
  'malformed_timezone',
  'unsupported_timezone',
  'unsupported_property_type',
  'invalid_count',
  'negative_count',
  'count_too_large',
  'invalid_array',
  'empty_array',
  'array_too_long',
  'malformed_string',
  'unknown_field',
  'unsupported_bed_type',
  'duplicate_bed_type',
  'impossible_configuration',
  'exceeds_bed_capacity',
  'duplicate_amenity',
  'invalid_date',
  'non_positive_length',
  'interval_too_long',
  'invalid_currency',
  'invalid_minor_amount',
  'negative_minor_amount',
  'minor_amount_too_large',
  'invalid_minimum_stay',
  'seasonal_overrides_too_many',
  'overlapping_override',
  'minimum_stay',
  'quote_total_too_large',
  'invalid_stay',
  'invalid_expiry',
  'invalid_availability_id',
  'invalid_booking_request_id',
  'rate_validation',
  'booking_request_validation',
]);

const SAFE_ICAL_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  ...ICAL_SOURCE_ERROR_MESSAGES,
  availability_conflict: 'The calendar source could not update availability.',
  sync_failed: 'Calendar synchronization failed.',
});

export function response(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string | readonly string[]>>,
): AdminHttpResponse {
  return {
    status,
    body,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...(headers ?? {}),
    },
  };
}

export function errorResponse(error: unknown): AdminHttpResponse {
  if (error instanceof AdminHttpError) {
    return response(error.status, { ...error.response() });
  }
  return response(500, {
    error: {
      code: 'internal_error',
      message: 'The admin request could not be completed.',
    },
  });
}

export function notFound(): never {
  throw new AdminHttpError(404, 'not_found', 'The requested admin resource was not found.');
}

export function methodNotAllowed(): never {
  throw new AdminHttpError(405, 'method_not_allowed', 'Method is not allowed for the route.');
}

export function fieldDetails(
  errors: readonly { readonly field?: unknown; readonly code?: unknown }[],
): readonly { readonly field: string; readonly message: string }[] {
  return errors.slice(0, 32).map((error, index) => {
    const field =
      typeof error.field === 'string' && error.field.length > 0
        ? error.field.slice(0, 128)
        : `field${index}`;
    const code = typeof error.code === 'string' ? error.code : undefined;
    return {
      field,
      message:
        code !== undefined && SAFE_ERROR_CODES.has(code)
          ? `The ${field.slice(0, 96)} field is invalid.`
          : 'Request validation failed.',
    };
  });
}

export function validationError(
  details?: readonly { readonly field?: unknown; readonly code?: unknown }[],
): never {
  throw new AdminHttpError(
    400,
    'validation_failed',
    'Request validation failed.',
    details === undefined ? undefined : fieldDetails(details),
  );
}

function persistenceErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' && code.length <= 128 ? code : undefined;
}

export function mapPersistenceError(error: unknown): AdminHttpError {
  const code = persistenceErrorCode(error);
  if (
    code === 'property_not_found' ||
    code === 'booking_request_not_found' ||
    code === 'rate_plan_not_found' ||
    code === 'organization_not_found' ||
    code === 'invalid_organization_id' ||
    code === 'invalid_property_id'
  ) {
    return new AdminHttpError(404, 'not_found', 'The requested admin resource was not found.');
  }
  if (
    code === 'availability_conflict' ||
    code === 'invalid_booking_request_transition' ||
    code === 'booking_request_expired'
  ) {
    return new AdminHttpError(409, 'conflict', 'The admin operation could not be applied.');
  }
  if (code !== undefined && (code.endsWith('_validation') || code.startsWith('invalid_'))) {
    const record = error as Record<string, unknown>;
    const errors = record['errors'];
    return new AdminHttpError(
      400,
      'validation_failed',
      'Request validation failed.',
      Array.isArray(errors) ? fieldDetails(errors) : undefined,
    );
  }
  return new AdminHttpError(500, 'internal_error', 'The admin request could not be completed.');
}

export function serializeProperty(property: PropertyConfiguration): AdminPropertyResponse {
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
      property.bedConfiguration.map((bed) => Object.freeze({ ...bed })),
    ),
    bathroomCount: property.bathroomCount,
    maximumGuests: property.maximumGuests,
    amenities: Object.freeze([...property.amenities]),
    hostNotes: property.hostNotes,
    operationalNotes: property.operationalNotes,
  });
}

export function pageData(property: PropertyConfiguration): AdminPageProperty {
  return {
    id: property.id,
    name: property.name,
    summary: property.summary,
    hostNotes: property.hostNotes,
    operationalNotes: property.operationalNotes,
  };
}

export function serializeRatePlan(plan: RatePlan): AdminRatePlanResponse {
  return Object.freeze({
    currency: plan.currency,
    baseNightlyRateMinor: plan.baseNightlyRateMinor,
    cleaningFeeMinor: plan.cleaningFeeMinor,
    minimumStayNights: plan.minimumStayNights,
    seasonalOverrides: Object.freeze(
      plan.seasonalOverrides.map((override) =>
        Object.freeze({
          arrival: override.arrival,
          departure: override.departure,
          nightlyRateMinor: override.nightlyRateMinor,
        }),
      ),
    ),
  });
}

export function serializeManualBlock(
  block: AvailabilityRecord,
  propertyId: string,
): AdminManualBlockResponse {
  if (block.propertyId !== propertyId || block.kind !== 'manual') {
    notFound();
  }
  return Object.freeze({
    id: block.id,
    propertyId: block.propertyId,
    kind: 'manual',
    status: block.status,
    arrival: block.arrival,
    departure: block.departure,
    expiresAt: block.expiresAt,
    reason: block.reason,
  });
}

export function serializeQuote(quote: QuoteBreakdown): QuoteBreakdown {
  return Object.freeze({
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

export function serializeBookingRequest(request: BookingRequestRecord): Record<string, unknown> {
  return Object.freeze({
    id: request.id,
    propertyId: request.propertyId,
    arrival: request.arrival,
    departure: request.departure,
    guestCount: request.guestCount,
    guestName: request.guestName,
    guestEmail: request.guestEmail,
    message: request.message,
    status: request.status,
    quote: serializeQuote(request.quote),
    createdAt: request.createdAt,
    ...(request.decidedAt === undefined ? {} : { decidedAt: request.decidedAt }),
  });
}

export function serializeUser(user: AdminSessionUser): AdminUserResponse {
  return Object.freeze({ id: user.id, email: user.email, role: user.role });
}

const MAX_SAFE_TIMESTAMP_LENGTH = 40;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function safeTimestamp(value: string | null): string | null {
  return value !== null &&
    typeof value === 'string' &&
    value.length <= MAX_SAFE_TIMESTAMP_LENGTH &&
    SAFE_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

export function serializeHealth(sourceId: string, result: ICalSyncHealth): Record<string, unknown> {
  const code =
    result.error !== null &&
    Object.prototype.hasOwnProperty.call(SAFE_ICAL_ERRORS, result.error.code)
      ? result.error.code
      : 'sync_failed';
  const error =
    result.error === null
      ? null
      : {
          code,
          message: SAFE_ICAL_ERRORS[code],
        };
  return Object.freeze({
    sourceId,
    lastAttemptAt: safeTimestamp(result.lastAttemptAt),
    lastSuccessAt: safeTimestamp(result.lastSuccessAt),
    stale: result.stale === true,
    error,
  });
}
