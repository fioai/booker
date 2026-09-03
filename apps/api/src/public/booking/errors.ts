import type {
  PublicApiErrorResponseV1,
  PublicValidationCodeV1,
  PublicValidationIssueV1,
} from '@booking-engine/sdk-typescript';
import {
  validatePublicIdempotencyKeyV1,
  validatePublicPropertyIdV1,
} from '@booking-engine/sdk-typescript';

import { PublicBookingApiError, type PublicHttpResponse } from './contracts.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function mapPersistenceError(error: unknown): PublicBookingApiError {
  if (!isPersistenceError(error)) {
    return new PublicBookingApiError(
      500,
      'internal_error',
      'The public API could not complete the request.',
    );
  }
  switch (error.code) {
    case 'property_not_found':
      return new PublicBookingApiError(404, 'property_not_found', 'Property was not found.');
    case 'rate_plan_not_found':
      return new PublicBookingApiError(
        404,
        'quote_unavailable',
        'A quote is not available for this property.',
      );
    case 'invalid_stay':
    case 'rate_validation':
    case 'booking_request_validation':
      return new PublicBookingApiError(
        400,
        'validation_failed',
        'Request validation failed.',
        validationDetails(error.errors),
      );
    case 'availability_conflict':
      return new PublicBookingApiError(
        409,
        'stay_unavailable',
        'The requested stay is not available.',
      );
    case 'duplicate_booking_request':
    case 'idempotency_key_reuse':
      return new PublicBookingApiError(
        409,
        'request_conflict',
        'The booking request could not be accepted.',
      );
    case 'invalid_organization_id':
    case 'invalid_property_id':
      return new PublicBookingApiError(404, 'property_not_found', 'Property was not found.');
    default:
      return new PublicBookingApiError(
        500,
        'internal_error',
        'The public API could not complete the request.',
      );
  }
}

export function throwValidation(result: {
  readonly ok: false;
  readonly errors: readonly PublicValidationIssueV1[];
}): never {
  throw new PublicBookingApiError(
    400,
    'validation_failed',
    'Request validation failed.',
    result.errors,
  );
}

export function requirePropertyId(propertyId: string): string {
  const result = validatePublicPropertyIdV1(propertyId);
  if (!result.ok) {
    throwValidation(result);
  }
  return result.value;
}

export function requireIdempotencyKey(idempotencyKey: string | undefined): string {
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
  const result = validatePublicIdempotencyKeyV1(idempotencyKey);
  if (!result.ok) {
    throwValidation(result);
  }
  return result.value;
}

export function errorResponse(error: unknown): PublicHttpResponse {
  if (error instanceof PublicBookingApiError) {
    return { status: error.status, body: error.response() };
  }
  return {
    status: 500,
    body: {
      error: { code: 'internal_error', message: 'The public API could not complete the request.' },
    } satisfies PublicApiErrorResponseV1,
  };
}
