import {
  BookingEngineApiErrorV1,
  PublicContractValidationErrorV1,
  PUBLIC_API_VERSION_V1,
  PUBLIC_BOOKING_LIMITS_V1,
  validatePublicAvailabilityRequestV1,
  validatePublicPropertyIdV1,
  validatePublicRequestToBookV1,
  validatePublicIdempotencyKeyV1,
  validatePublicQuoteRequestV1,
  validatePublicStayV1,
  type PublicApiErrorV1,
  type PublicApiErrorCodeV1,
  type PublicValidationCodeV1,
  type PublicValidationIssueV1,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PUBLIC_BOOKING_LIMITS_V1.maximumIdentifierLength &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  );
}

function isIsoCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

interface ParsedPublicDateV1 {
  readonly value: string;
  readonly dayNumber: number;
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

function civilFromDays(dayNumber: number): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const era = Math.floor(dayNumber / 146097);
  const dayOfEra = dayNumber - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function parsePublicDate(value: unknown): ParsedPublicDateV1 | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return undefined;
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
    return undefined;
  }
  return { value, dayNumber: daysFromCivil(year, month, day) };
}

function dateAtOffset(interval: ParsedPublicDateV1, offset: number): string {
  const date = civilFromDays(interval.dayNumber + offset);
  return formatDate(date.year, date.month, date.day);
}

function isPublicStayFields(value: Record<string, unknown>): boolean {
  const interval = validatePublicStayV1({
    arrival: value['arrival'],
    departure: value['departure'],
  });
  return interval.ok && value['nights'] === interval.value.nights;
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
    !isIdentifier(value['id']) ||
    !isBoundedText(value['name'], 120) ||
    !isBoundedText(value['summary'], 500) ||
    typeof value['country'] !== 'string' ||
    !/^[A-Z]{2}$/u.test(value['country']) ||
    !isBoundedText(value['timezone'], 64) ||
    !isIsoCurrency(value['currency']) ||
    !isPublicPropertyType(value['propertyType']) ||
    !isSafeNonNegativeInteger(value['bedroomCount']) ||
    value['bedroomCount'] > 100 ||
    !isSafeNonNegativeInteger(value['bathroomCount']) ||
    value['bathroomCount'] > 100 ||
    value['bathroomCount'] < 1 ||
    !isSafeNonNegativeInteger(value['maximumGuests']) ||
    value['maximumGuests'] > PUBLIC_BOOKING_LIMITS_V1.maximumGuestCount ||
    value['maximumGuests'] < 1 ||
    !Array.isArray(value['bedConfiguration']) ||
    value['bedConfiguration'].length > 16 ||
    !Array.isArray(value['amenities']) ||
    value['amenities'].length > 32 ||
    !value['amenities'].every((amenity) => isBoundedText(amenity, 80)) ||
    !isBoundedText(value['hostNotes'], 2_000)
  ) {
    return false;
  }
  return value['bedConfiguration'].every(
    (bed) =>
      isRecord(bed) &&
      hasExactKeys(bed, ['type', 'quantity']) &&
      isPublicBedType(bed['type']) &&
      isSafeNonNegativeInteger(bed['quantity']) &&
      bed['quantity'] > 0 &&
      bed['quantity'] <= 100,
  );
}

function isPublicAvailability(value: unknown): value is PublicAvailabilityV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['propertyId', 'arrival', 'departure', 'nights', 'available']) &&
    isPublicStayFields(value) &&
    isIdentifier(value['propertyId']) &&
    typeof value['available'] === 'boolean'
  );
}

function isPublicQuote(value: unknown): value is PublicQuoteV1 {
  if (
    !isRecord(value) ||
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
    !isPublicStayFields(value) ||
    !isIdentifier(value['propertyId']) ||
    !isIsoCurrency(value['currency']) ||
    !isSafeNonNegativeInteger(value['minimumStayNights']) ||
    value['minimumStayNights'] < 1 ||
    value['minimumStayNights'] > PUBLIC_BOOKING_LIMITS_V1.maximumStayNights ||
    !isSafeNonNegativeInteger(value['cleaningFeeMinor']) ||
    !Array.isArray(value['nightly']) ||
    value['nightly'].length !== value['nights'] ||
    value['nightly'].length > PUBLIC_BOOKING_LIMITS_V1.maximumStayNights
  ) {
    return false;
  }

  const arrival = parsePublicDate(value['arrival']);
  if (arrival === undefined) {
    return false;
  }
  let nightlySubtotalMinor = 0;
  for (const [index, rawNight] of value['nightly'].entries()) {
    if (
      !isRecord(rawNight) ||
      !hasExactKeys(rawNight, ['date', 'amountMinor', 'source']) ||
      !isSafeNonNegativeInteger(rawNight['amountMinor']) ||
      (rawNight['source'] !== 'base' && rawNight['source'] !== 'seasonal_override') ||
      parsePublicDate(rawNight['date']) === undefined ||
      rawNight['date'] !== dateAtOffset(arrival, index)
    ) {
      return false;
    }
    nightlySubtotalMinor += rawNight['amountMinor'] as number;
    if (!Number.isSafeInteger(nightlySubtotalMinor)) {
      return false;
    }
  }
  if (
    !isSafeNonNegativeInteger(value['nightlySubtotalMinor']) ||
    value['nightlySubtotalMinor'] !== nightlySubtotalMinor ||
    !isSafeNonNegativeInteger(value['totalMinor'])
  ) {
    return false;
  }
  return value['totalMinor'] === nightlySubtotalMinor + value['cleaningFeeMinor'];
}

const PUBLIC_REQUEST_STATUSES_V1 = ['pending', 'approved', 'rejected', 'expired'] as const;

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (match === null || parsePublicDate(match[1]) === undefined) {
    return false;
  }
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isPublicRequestToBook(value: unknown): value is PublicRequestToBookV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'propertyId',
      'arrival',
      'departure',
      'nights',
      'guestCount',
      'status',
      'quote',
      'createdAt',
    ]) ||
    !isPublicStayFields(value) ||
    !isIdentifier(value['id']) ||
    !isIdentifier(value['propertyId']) ||
    !isSafeNonNegativeInteger(value['guestCount']) ||
    value['guestCount'] < 1 ||
    value['guestCount'] > PUBLIC_BOOKING_LIMITS_V1.maximumGuestCount ||
    !PUBLIC_REQUEST_STATUSES_V1.includes(
      value['status'] as (typeof PUBLIC_REQUEST_STATUSES_V1)[number],
    ) ||
    !isPublicQuote(value['quote']) ||
    !isIsoTimestamp(value['createdAt'])
  ) {
    return false;
  }
  const quote = value['quote'];
  return (
    quote.propertyId === value['propertyId'] &&
    quote.arrival === value['arrival'] &&
    quote.departure === value['departure'] &&
    quote.nights === value['nights']
  );
}

type PublicV1Decoder<T> = (value: unknown) => T | undefined;

function decodeV1Payload<T>(body: unknown, decoder: PublicV1Decoder<T>): T | undefined {
  return decoder(body);
}

function invalidResponse(status: number): never {
  throw new BookingEngineApiErrorV1(status, {
    code: 'internal_error',
    message: 'The public API returned an invalid response.',
  });
}

function decodePublicResponse<T>(
  status: number,
  body: unknown,
  guard: (value: unknown) => value is T,
): T {
  const decoded = decodeV1Payload(body, (value) => (guard(value) ? value : undefined));
  return decoded === undefined ? invalidResponse(status) : decoded;
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

const PUBLIC_VALIDATION_CODES_V1: readonly PublicValidationCodeV1[] = [
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

function isBoundedErrorField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9_.[\]-]*$/u.test(value)
  );
}

function isPublicValidationIssue(value: unknown): value is PublicValidationIssueV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['field', 'code', 'message']) &&
    isBoundedErrorField(value['field']) &&
    typeof value['code'] === 'string' &&
    PUBLIC_VALIDATION_CODES_V1.includes(value['code'] as PublicValidationCodeV1) &&
    isBoundedText(value['message'], 2_000)
  );
}

function decodePublicError(value: unknown): PublicApiErrorV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['error']) || !isRecord(value['error'])) {
    return undefined;
  }
  const rawError = value['error'];
  const hasDetails = Object.hasOwn(rawError, 'details');
  if (
    (hasDetails
      ? !hasExactKeys(rawError, ['code', 'message', 'details'])
      : !hasExactKeys(rawError, ['code', 'message'])) ||
    typeof rawError['code'] !== 'string' ||
    !PUBLIC_ERROR_CODES_V1.includes(rawError['code'] as PublicApiErrorCodeV1) ||
    !isBoundedText(rawError['message'], 2_000)
  ) {
    return undefined;
  }
  if (!hasDetails) {
    return {
      code: rawError['code'] as PublicApiErrorCodeV1,
      message: rawError['message'],
    };
  }
  if (
    !Array.isArray(rawError['details']) ||
    !rawError['details'].every((detail) => isPublicValidationIssue(detail))
  ) {
    return undefined;
  }
  return {
    code: rawError['code'] as PublicApiErrorCodeV1,
    message: rawError['message'],
    details: rawError['details'],
  };
}

function decodeError(status: number, body: unknown): BookingEngineApiErrorV1 {
  const publicError = decodeV1Payload(body, decodePublicError);
  if (publicError !== undefined) {
    return new BookingEngineApiErrorV1(status, publicError);
  }
  return new BookingEngineApiErrorV1(status, {
    code: 'internal_error',
    message: 'The public API returned an invalid error response.',
  });
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
        PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations.requestToBook.method,
        propertyPath(propertyId, 'requestToBook'),
        input,
        isPublicRequestToBook,
        { 'Idempotency-Key': idempotencyKey },
      );
    },
  };
}
