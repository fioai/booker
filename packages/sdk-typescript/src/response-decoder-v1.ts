import {
  countUnicodeCodePointsV1,
  PUBLIC_API_ERROR_CODES_V1,
  PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1,
  PUBLIC_BOUNDED_TEXT_PATTERN_V1,
  PUBLIC_BOOKING_REQUEST_STATUSES_V1,
  PUBLIC_IDENTIFIER_PATTERN_V1,
  PUBLIC_MINOR_AMOUNT_MAXIMUM_V1,
  PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1,
  PUBLIC_VALIDATION_CODES_V1,
  PUBLIC_VALIDATION_ISSUE_BOUNDS_V1,
  PUBLIC_VALIDATION_ISSUE_FIELD_PATTERN_V1,
} from './contract-constraints-v1.js';
import {
  PUBLIC_BOOKING_CONTRACT_MANIFEST_V1,
  type PublicBookingOperationKeyV1,
} from './contract-manifest-v1.js';
import {
  BookingEngineApiErrorV1,
  PUBLIC_BOOKING_LIMITS_V1,
  validatePublicStayV1,
  type PublicApiErrorV1,
  type PublicAvailabilityV1,
  type PublicPropertyV1,
  type PublicQuoteV1,
  type PublicRequestToBookV1,
  type PublicValidationIssueV1,
} from './public-contract-v1.js';

interface PublicJsonResponseV1 {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

type PublicResponseGuardV1<T> = (value: unknown) => value is T;

export interface PublicResponseDecoderContextV1 {
  readonly operation: PublicBookingOperationKeyV1;
  readonly propertyId: string;
  readonly arrival?: string;
  readonly departure?: string;
  readonly guestCount?: number;
}

const identifierPattern = new RegExp(PUBLIC_IDENTIFIER_PATTERN_V1, 'u');
const validationIssueFieldPattern = new RegExp(PUBLIC_VALIDATION_ISSUE_FIELD_PATTERN_V1, 'u');
const boundedTextPattern = new RegExp(PUBLIC_BOUNDED_TEXT_PATTERN_V1, 'u');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const bounds = PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.id;
  const length = countUnicodeCodePointsV1(value, bounds.maxLength);
  return length >= bounds.minLength && length <= bounds.maxLength && identifierPattern.test(value);
}

function isIsoCurrency(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const expectedLength = PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.currency.minLength;
  return (
    countUnicodeCodePointsV1(value, expectedLength) === expectedLength && /^[A-Z]{3}$/u.test(value)
  );
}

function isIsoCountry(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const expectedLength = PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1.country.minLength;
  return (
    countUnicodeCodePointsV1(value, expectedLength) === expectedLength && /^[A-Z]{2}$/u.test(value)
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPublicMinorAmount(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value <= PUBLIC_MINOR_AMOUNT_MAXIMUM_V1;
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = countUnicodeCodePointsV1(value, maximum);
  return length >= minimum && length <= maximum && boundedTextPattern.test(value);
}

function isValidationIssueField(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const bounds = PUBLIC_VALIDATION_ISSUE_BOUNDS_V1.field;
  const length = countUnicodeCodePointsV1(value, bounds.maxLength);
  return (
    length >= bounds.minLength &&
    length <= bounds.maxLength &&
    validationIssueFieldPattern.test(value)
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
  const bounds = PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1;
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
    !isBoundedText(value['name'], bounds.name.minLength, bounds.name.maxLength) ||
    !isBoundedText(value['summary'], bounds.summary.minLength, bounds.summary.maxLength) ||
    !isIsoCountry(value['country']) ||
    !isBoundedText(value['timezone'], bounds.timezone.minLength, bounds.timezone.maxLength) ||
    !isIsoCurrency(value['currency']) ||
    !isPublicPropertyType(value['propertyType']) ||
    !isSafeNonNegativeInteger(value['bedroomCount']) ||
    value['bedroomCount'] < bounds.bedroomCount.minimum ||
    value['bedroomCount'] > bounds.bedroomCount.maximum ||
    !isSafeNonNegativeInteger(value['bathroomCount']) ||
    value['bathroomCount'] < bounds.bathroomCount.minimum ||
    value['bathroomCount'] > bounds.bathroomCount.maximum ||
    !isSafeNonNegativeInteger(value['maximumGuests']) ||
    value['maximumGuests'] < bounds.maximumGuests.minimum ||
    value['maximumGuests'] > bounds.maximumGuests.maximum ||
    !Array.isArray(value['bedConfiguration']) ||
    value['bedConfiguration'].length < bounds.bedConfiguration.minItems ||
    value['bedConfiguration'].length > bounds.bedConfiguration.maxItems ||
    !Array.isArray(value['amenities']) ||
    value['amenities'].length > bounds.amenities.maxItems ||
    !value['amenities'].every((amenity) =>
      isBoundedText(amenity, bounds.amenities.items.minLength, bounds.amenities.items.maxLength),
    ) ||
    !isBoundedText(value['hostNotes'], bounds.hostNotes.minLength, bounds.hostNotes.maxLength)
  ) {
    return false;
  }

  const quantityBounds = bounds.bedConfiguration.items.properties.quantity;
  return value['bedConfiguration'].every(
    (bed) =>
      isRecord(bed) &&
      hasExactKeys(bed, ['type', 'quantity']) &&
      isPublicBedType(bed['type']) &&
      isSafeNonNegativeInteger(bed['quantity']) &&
      bed['quantity'] >= quantityBounds.minimum &&
      bed['quantity'] <= quantityBounds.maximum,
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
    !isPublicStayFields(value)
  ) {
    return false;
  }

  const nights = value['nights'];
  const minimumStayNights = value['minimumStayNights'];
  if (
    !isSafeNonNegativeInteger(nights) ||
    !isIdentifier(value['propertyId']) ||
    !isIsoCurrency(value['currency']) ||
    !isSafeNonNegativeInteger(minimumStayNights) ||
    minimumStayNights < 1 ||
    minimumStayNights > PUBLIC_BOOKING_LIMITS_V1.maximumStayNights ||
    minimumStayNights > nights ||
    !isPublicMinorAmount(value['cleaningFeeMinor']) ||
    !Array.isArray(value['nightly']) ||
    value['nightly'].length !== nights ||
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
      !isPublicMinorAmount(rawNight['amountMinor']) ||
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
    !PUBLIC_BOOKING_REQUEST_STATUSES_V1.includes(
      value['status'] as (typeof PUBLIC_BOOKING_REQUEST_STATUSES_V1)[number],
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

function invalidResponseError(
  status: number,
  successfulResponse: boolean,
): BookingEngineApiErrorV1 {
  return new BookingEngineApiErrorV1(status, {
    code: 'internal_error',
    message: successfulResponse
      ? 'The public API returned an invalid response.'
      : 'The public API returned an invalid error response.',
  });
}

function matchesPublicResponseContext(
  value: unknown,
  context: PublicResponseDecoderContextV1,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const responsePropertyId = context.operation === 'property' ? value['id'] : value['propertyId'];
  if (responsePropertyId !== context.propertyId) {
    return false;
  }
  if (context.operation === 'property') {
    return true;
  }
  if (
    context.arrival === undefined ||
    context.departure === undefined ||
    value['arrival'] !== context.arrival ||
    value['departure'] !== context.departure
  ) {
    return false;
  }
  return (
    context.operation !== 'requestToBook' ||
    (context.guestCount !== undefined && value['guestCount'] === context.guestCount)
  );
}

function decodePublicResponse<T>(
  status: number,
  body: unknown,
  guard: PublicResponseGuardV1<T>,
  context: PublicResponseDecoderContextV1,
): T {
  if (!guard(body) || !matchesPublicResponseContext(body, context)) {
    throw invalidResponseError(status, true);
  }
  return body;
}

function isPublicValidationIssue(value: unknown): value is PublicValidationIssueV1 {
  const bounds = PUBLIC_VALIDATION_ISSUE_BOUNDS_V1;
  return (
    isRecord(value) &&
    hasExactKeys(value, ['field', 'code', 'message']) &&
    isValidationIssueField(value['field']) &&
    typeof value['code'] === 'string' &&
    PUBLIC_VALIDATION_CODES_V1.includes(
      value['code'] as (typeof PUBLIC_VALIDATION_CODES_V1)[number],
    ) &&
    isBoundedText(value['message'], bounds.message.minLength, bounds.message.maxLength)
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
    !PUBLIC_API_ERROR_CODES_V1.includes(
      rawError['code'] as (typeof PUBLIC_API_ERROR_CODES_V1)[number],
    ) ||
    !isBoundedText(
      rawError['message'],
      PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1.minLength,
      PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1.maxLength,
    )
  ) {
    return undefined;
  }
  if (!hasDetails) {
    return {
      code: rawError['code'] as PublicApiErrorV1['code'],
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
    code: rawError['code'] as PublicApiErrorV1['code'],
    message: rawError['message'],
    details: rawError['details'],
  };
}

function isAllowedPublicErrorCode(
  operation: PublicBookingOperationKeyV1,
  status: number,
  code: PublicApiErrorV1['code'],
): boolean {
  const errorCodesByStatus: Readonly<Partial<Record<number, readonly PublicApiErrorV1['code'][]>>> =
    PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations[operation].errorCodesByStatus;
  return errorCodesByStatus[status]?.includes(code) === true;
}

function decodeError(
  operation: PublicBookingOperationKeyV1,
  status: number,
  body: unknown,
): BookingEngineApiErrorV1 {
  const publicError = decodePublicError(body);
  return publicError === undefined || !isAllowedPublicErrorCode(operation, status, publicError.code)
    ? invalidResponseError(status, false)
    : new BookingEngineApiErrorV1(status, publicError);
}

export const PUBLIC_RESPONSE_DECODERS_V1 = Object.freeze({
  property: isPublicProperty,
  availability: isPublicAvailability,
  quote: isPublicQuote,
  requestToBook: isPublicRequestToBook,
});

export async function readPublicResponseV1<T>(
  response: PublicJsonResponseV1,
  guard: PublicResponseGuardV1<T>,
  context: PublicResponseDecoderContextV1,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponseError(response.status, response.ok);
  }

  const documentedStatuses: readonly number[] =
    PUBLIC_BOOKING_CONTRACT_MANIFEST_V1.operations[context.operation].statuses;
  let successStatus: number | undefined;
  for (const status of documentedStatuses) {
    if (status >= 200 && status < 300) {
      if (successStatus !== undefined) {
        throw invalidResponseError(response.status, response.ok);
      }
      successStatus = status;
    }
  }
  if (
    successStatus === undefined ||
    !documentedStatuses.includes(response.status) ||
    response.ok !== (response.status === successStatus)
  ) {
    throw invalidResponseError(response.status, response.ok);
  }

  if (!response.ok) {
    throw decodeError(context.operation, response.status, body);
  }
  return decodePublicResponse(response.status, body, guard, context);
}
