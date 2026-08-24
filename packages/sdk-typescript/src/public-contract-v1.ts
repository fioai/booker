/** Public contract versions are explicit so consumers do not depend on private shapes. */
export type PublicApiVersionV1 = 'v1';

export const PUBLIC_API_VERSION_V1: PublicApiVersionV1 = 'v1';

export const PUBLIC_BOOKING_LIMITS_V1 = Object.freeze({
  maximumIdentifierLength: 64,
  maximumStayNights: 3660,
  maximumGuestCount: 200,
  maximumGuestNameLength: 120,
  maximumGuestEmailLength: 254,
  maximumMessageLength: 2000,
  maximumIdempotencyKeyLength: 128,
});

export type PublicPropertyTypeV1 =
  | 'apartment'
  | 'bungalow'
  | 'cabin'
  | 'cottage'
  | 'house'
  | 'studio'
  | 'villa';

export type PublicBedTypeV1 = 'bunk' | 'double' | 'king' | 'queen' | 'single' | 'sofa-bed';

export interface PublicBedConfigurationV1 {
  readonly type: PublicBedTypeV1;
  readonly quantity: number;
}

/** Guest-visible property data. Private operational notes intentionally have no field here. */
export interface PublicPropertyConfigurationV1 {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: PublicPropertyTypeV1;
  readonly bedroomCount: number;
  readonly bedConfiguration: readonly PublicBedConfigurationV1[];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
  readonly hostNotes: string;
}

export type PublicPropertyV1 = PublicPropertyConfigurationV1;

export type PublicValidationCodeV1 =
  | 'invalid_input'
  | 'missing_field'
  | 'invalid_string'
  | 'empty_string'
  | 'string_too_long'
  | 'invalid_identifier'
  | 'invalid_date'
  | 'non_positive_length'
  | 'interval_too_long'
  | 'invalid_guest_count'
  | 'invalid_email'
  | 'invalid_value'
  | 'unknown_field';

export interface PublicValidationIssueV1 {
  readonly field: string;
  readonly code: PublicValidationCodeV1;
  readonly message: string;
}

export type PublicValidationResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly PublicValidationIssueV1[] };

export type PublicApiErrorCodeV1 =
  | 'validation_failed'
  | 'property_not_found'
  | 'quote_unavailable'
  | 'stay_unavailable'
  | 'request_conflict'
  | 'route_not_found'
  | 'method_not_allowed'
  | 'internal_error';

export interface PublicApiErrorV1 {
  readonly code: PublicApiErrorCodeV1;
  readonly message: string;
  readonly details?: readonly PublicValidationIssueV1[];
}

export interface PublicApiErrorResponseV1 {
  readonly error: PublicApiErrorV1;
}

export interface PublicStayInputV1 {
  readonly arrival: string;
  readonly departure: string;
}

export interface PublicStayV1 extends PublicStayInputV1 {
  readonly nights: number;
}

export type PublicAvailabilityRequestV1 = PublicStayInputV1;
export type PublicQuoteRequestV1 = PublicStayInputV1;

export interface PublicAvailabilityV1 extends PublicStayV1 {
  readonly propertyId: string;
  readonly available: boolean;
}

export type PublicQuoteNightSourceV1 = 'base' | 'seasonal_override';

export interface PublicQuoteNightV1 {
  readonly date: string;
  readonly amountMinor: number;
  readonly source: PublicQuoteNightSourceV1;
}

export interface PublicQuoteV1 extends PublicStayV1 {
  readonly propertyId: string;
  readonly currency: string;
  readonly nightly: readonly PublicQuoteNightV1[];
  readonly nightlySubtotalMinor: number;
  readonly cleaningFeeMinor: number;
  readonly totalMinor: number;
  readonly minimumStayNights: number;
}

export interface PublicRequestToBookInputV1 extends PublicStayInputV1 {
  readonly guestCount: number;
  readonly guestName: string;
  readonly guestEmail: string;
  readonly message?: string;
}

export type PublicBookingRequestInputV1 = PublicRequestToBookInputV1;

export type PublicBookingRequestStatusV1 = 'pending' | 'approved' | 'rejected' | 'expired';

/** The request response contains no guest contact fields or tenant identifiers. */
export interface PublicRequestToBookV1 extends PublicStayV1 {
  readonly id: string;
  readonly propertyId: string;
  readonly guestCount: number;
  readonly status: PublicBookingRequestStatusV1;
  readonly quote: PublicQuoteV1;
  readonly createdAt: string;
}

export interface PublicRequestToBookOptionsV1 {
  readonly idempotencyKey: string;
}

export type PublicBookingRequestV1 = PublicRequestToBookV1;

interface ParsedDateV1 {
  readonly dayNumber: number;
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

function issue(
  field: string,
  code: PublicValidationCodeV1,
  message: string,
): PublicValidationIssueV1 {
  return { field, code, message };
}

function parseDate(
  value: unknown,
  field: string,
): { readonly parsed: ParsedDateV1 } | { readonly error: PublicValidationIssueV1 } {
  if (value === undefined) {
    return { error: issue(field, 'missing_field', `${field} is required.`) };
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return {
      error: issue(field, 'invalid_date', `${field} must be a YYYY-MM-DD local calendar date.`),
    };
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return { error: issue(field, 'invalid_date', `${field} is not a valid Gregorian date.`) };
  }
  return { parsed: { value, dayNumber: daysFromCivil(year, month, day) } };
}

function validateRecord(
  input: unknown,
  allowedFields: readonly string[],
):
  | { readonly record: Record<string, unknown> }
  | { readonly errors: readonly PublicValidationIssueV1[] } {
  if (!isRecord(input)) {
    return { errors: [issue('request', 'invalid_input', 'request must be an object.')] };
  }
  const errors = Object.keys(input)
    .filter((field) => !allowedFields.includes(field))
    .map((field) => issue(field, 'unknown_field', `${field} is not part of the public contract.`));
  return errors.length === 0 ? { record: input } : { errors };
}

export function validatePublicPropertyIdV1(
  value: unknown,
  field = 'propertyId',
): PublicValidationResultV1<string> {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PUBLIC_BOOKING_LIMITS_V1.maximumIdentifierLength
  ) {
    return {
      ok: false,
      errors: [
        issue(
          field,
          'invalid_identifier',
          `${field} must be a non-empty identifier of at most 64 characters.`,
        ),
      ],
    };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) {
    return {
      ok: false,
      errors: [
        issue(
          field,
          'invalid_identifier',
          `${field} must contain only letters, numbers, underscores, and hyphens.`,
        ),
      ],
    };
  }
  return { ok: true, value };
}

export function validatePublicStayV1(input: unknown): PublicValidationResultV1<PublicStayV1> {
  const validated = validateRecord(input, ['arrival', 'departure']);
  if ('errors' in validated) {
    return { ok: false, errors: validated.errors };
  }

  const errors: PublicValidationIssueV1[] = [];
  const arrival = parseDate(validated.record['arrival'], 'arrival');
  const departure = parseDate(validated.record['departure'], 'departure');
  if ('error' in arrival) {
    errors.push(arrival.error);
  }
  if ('error' in departure) {
    errors.push(departure.error);
  }
  if ('error' in arrival || 'error' in departure) {
    return { ok: false, errors };
  }
  if (arrival.parsed.dayNumber >= departure.parsed.dayNumber) {
    return {
      ok: false,
      errors: [issue('interval', 'non_positive_length', 'departure must be after arrival.')],
    };
  }
  const nights = departure.parsed.dayNumber - arrival.parsed.dayNumber;
  if (nights > PUBLIC_BOOKING_LIMITS_V1.maximumStayNights) {
    return {
      ok: false,
      errors: [
        issue(
          'interval',
          'interval_too_long',
          `interval must be at most ${PUBLIC_BOOKING_LIMITS_V1.maximumStayNights} nights.`,
        ),
      ],
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      arrival: arrival.parsed.value,
      departure: departure.parsed.value,
      nights,
    }),
  };
}

export function validatePublicAvailabilityRequestV1(
  input: unknown,
): PublicValidationResultV1<PublicAvailabilityRequestV1> {
  const result = validatePublicStayV1(input);
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: { arrival: result.value.arrival, departure: result.value.departure } };
}

export const validatePublicQuoteRequestV1 = validatePublicAvailabilityRequestV1;

function validateBoundedText(
  value: unknown,
  field: string,
  maximum: number,
  required: boolean,
): PublicValidationIssueV1 | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return issue(field, 'invalid_string', `${field} must be a string.`);
  }
  if (value.trim().length === 0) {
    return issue(field, 'empty_string', `${field} must not be empty.`);
  }
  if (value.length > maximum) {
    return issue(field, 'string_too_long', `${field} must be at most ${maximum} characters.`);
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return issue(field, 'invalid_string', `${field} must not contain control characters.`);
  }
  return undefined;
}

export function validatePublicRequestToBookV1(
  input: unknown,
): PublicValidationResultV1<PublicRequestToBookInputV1 & PublicStayV1> {
  const validated = validateRecord(input, [
    'arrival',
    'departure',
    'guestCount',
    'guestName',
    'guestEmail',
    'message',
  ]);
  if ('errors' in validated) {
    return { ok: false, errors: validated.errors };
  }

  const stay = validatePublicStayV1({
    arrival: validated.record['arrival'],
    departure: validated.record['departure'],
  });
  const errors: PublicValidationIssueV1[] = stay.ok ? [] : [...stay.errors];
  const guestCount = validated.record['guestCount'];
  if (
    typeof guestCount !== 'number' ||
    !Number.isSafeInteger(guestCount) ||
    guestCount < 1 ||
    guestCount > PUBLIC_BOOKING_LIMITS_V1.maximumGuestCount
  ) {
    errors.push(
      issue(
        'guestCount',
        'invalid_guest_count',
        `guestCount must be an integer from 1 to ${PUBLIC_BOOKING_LIMITS_V1.maximumGuestCount}.`,
      ),
    );
  }
  const guestNameError = validateBoundedText(
    validated.record['guestName'],
    'guestName',
    PUBLIC_BOOKING_LIMITS_V1.maximumGuestNameLength,
    true,
  );
  if (guestNameError !== undefined) {
    errors.push(guestNameError);
  }
  const guestEmailError = validateBoundedText(
    validated.record['guestEmail'],
    'guestEmail',
    PUBLIC_BOOKING_LIMITS_V1.maximumGuestEmailLength,
    true,
  );
  if (guestEmailError !== undefined) {
    errors.push(guestEmailError);
  } else if (
    typeof validated.record['guestEmail'] === 'string' &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(validated.record['guestEmail'])
  ) {
    errors.push(issue('guestEmail', 'invalid_email', 'guestEmail must be a valid email address.'));
  }
  const messageError = validateBoundedText(
    validated.record['message'],
    'message',
    PUBLIC_BOOKING_LIMITS_V1.maximumMessageLength,
    false,
  );
  if (messageError !== undefined) {
    errors.push(messageError);
  }
  if (!stay.ok || errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...stay.value,
      guestCount: guestCount as number,
      guestName: validated.record['guestName'] as string,
      guestEmail: validated.record['guestEmail'] as string,
      ...(validated.record['message'] === undefined
        ? {}
        : { message: validated.record['message'] as string }),
    }),
  };
}

export function validatePublicIdempotencyKeyV1(value: unknown): PublicValidationResultV1<string> {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > PUBLIC_BOOKING_LIMITS_V1.maximumIdempotencyKeyLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return {
      ok: false,
      errors: [
        issue(
          'idempotencyKey',
          'invalid_string',
          `idempotencyKey must be a non-empty string of at most ${PUBLIC_BOOKING_LIMITS_V1.maximumIdempotencyKeyLength} characters.`,
        ),
      ],
    };
  }
  return { ok: true, value: value.trim() };
}

export class PublicContractValidationErrorV1 extends Error {
  readonly code = 'validation_failed' as const;
  readonly details: readonly PublicValidationIssueV1[];

  constructor(details: readonly PublicValidationIssueV1[]) {
    super('Request validation failed.');
    this.name = 'PublicContractValidationErrorV1';
    this.details = details;
  }
}

export class BookingEngineApiErrorV1 extends Error {
  readonly status: number;
  readonly code: PublicApiErrorCodeV1;
  readonly details: readonly PublicValidationIssueV1[] | undefined;

  constructor(status: number, error: PublicApiErrorV1) {
    super(error.message);
    this.name = 'BookingEngineApiErrorV1';
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}
