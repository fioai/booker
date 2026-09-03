import type {
  AvailabilityRatesValidationError,
  PropertyValidationError,
  QuoteSnapshotValidationError,
} from '@booking-engine/booking-core';

export type PersistenceErrorCode =
  | 'database_corruption'
  | 'duplicate_organization'
  | 'duplicate_property'
  | 'invalid_organization_id'
  | 'invalid_organization_name'
  | 'invalid_property_id'
  | 'invalid_availability_id'
  | 'invalid_booking_request_id'
  | 'invalid_stay'
  | 'invalid_expiry'
  | 'invalid_rate_plan'
  | 'rate_validation'
  | 'rate_plan_not_found'
  | 'organization_not_found'
  | 'property_not_found'
  | 'booking_request_validation'
  | 'duplicate_booking_request'
  | 'booking_request_not_found'
  | 'invalid_booking_request_transition'
  | 'booking_request_expired'
  | 'idempotency_key_reuse'
  | 'duplicate_availability_record'
  | 'availability_conflict'
  | 'availability_not_found'
  | 'property_validation'
  | 'outbox_validation'
  | 'outbox_delivery_failed'
  | 'invalid_owner_id'
  | 'invalid_owner_email'
  | 'invalid_owner_role'
  | 'invalid_password_hash'
  | 'duplicate_owner_identity'
  | 'owner_identity_not_found'
  | 'membership_not_found'
  | 'owner_auth_validation'
  | 'payment_validation'
  | 'payment_request_not_found'
  | 'payment_request_not_approved'
  | 'payment_occupancy_unavailable'
  | 'payment_checkout_not_found'
  | 'payment_provider_mismatch'
  | 'payment_retry_exhausted'
  | 'payment_event_rejected'
  | 'payment_event_duplicate';

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly errors:
    | readonly (
        | PropertyValidationError
        | AvailabilityRatesValidationError
        | QuoteSnapshotValidationError
      )[]
    | undefined;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    errors?: readonly (
      | PropertyValidationError
      | AvailabilityRatesValidationError
      | QuoteSnapshotValidationError
    )[],
  ) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.errors = errors;
  }
}

export function isPostgresError(
  error: unknown,
): error is { readonly code?: string; readonly constraint?: string } {
  return typeof error === 'object' && error !== null;
}
