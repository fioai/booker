import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  createLocalDateIntervalV1,
  createPropertyConfigurationV1,
  createRatePlanV1,
  type PropertyConfigurationInputV1,
  type PropertyConfigurationV1,
  type QuoteBreakdownV1,
  type RatePlanV1,
} from '@lotus-booking/booking-core';
import type {
  AvailabilityRecordV1,
  AvailabilityRepository,
  BookingRequestRecordV1,
  BookingRequestRepositoryV1,
  ICalScope,
  OrganizationScope,
  PropertyRepository,
  RateRepository,
} from '@lotus-booking/database-postgres';

import {
  authenticateOwnerV1,
  createAdminSessionStoreV1,
  type AdminCredentialRecordV1,
  type AdminCredentialStoreV1,
  type AdminRoleV1,
  type AdminSessionStoreOptionsV1,
  type AdminSessionStoreV1,
  type AdminSessionV1,
  type AdminSessionUserV1,
} from './admin-auth.js';
import type { ICalSyncHealth, ICalSyncRunResult } from './jobs/ical-sync.js';

export interface AdminICalHealthPortV1 {
  health(scope: ICalScope, sourceId: string): ICalSyncHealth | Promise<ICalSyncHealth>;
}

export interface AdminHttpApiDependenciesV1 {
  readonly credentials: AdminCredentialStoreV1;
  readonly properties: Pick<PropertyRepository, 'findById' | 'update'>;
  readonly rates: Pick<RateRepository, 'getRatePlan' | 'saveRatePlan'>;
  readonly availability: Pick<
    AvailabilityRepository,
    'listManualBlocks' | 'createManualBlock' | 'releaseManualBlock'
  >;
  readonly bookingRequests: Pick<
    BookingRequestRepositoryV1,
    'find' | 'approve' | 'reject' | 'recheckAvailability'
  > & {
    readonly list?: (
      scope: OrganizationScope,
      propertyId: string,
    ) => Promise<readonly BookingRequestRecordV1[]>;
  };
  readonly ical: AdminICalHealthPortV1;
}

export interface AdminPagePropertyV1 {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export interface AdminHttpApiOptionsV1 {
  readonly secureCookies?: boolean;
  readonly sessionStore?: AdminSessionStoreV1;
  readonly session?: AdminSessionStoreOptionsV1;
  /** Optional exact origin for deployments behind a known local reverse proxy. */
  readonly origin?: string;
  readonly renderPropertyPage?: (input: {
    readonly property: AdminPagePropertyV1;
    readonly csrfToken: string;
  }) => string;
}

export interface AdminHttpRequestV1 {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface AdminHttpResponseV1 {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
}

export interface AdminHttpApiV1 {
  handle(request: AdminHttpRequestV1): Promise<AdminHttpResponseV1>;
}

export class AdminHttpErrorV1 extends Error {
  readonly status: number;
  readonly code:
    | 'invalid_credentials'
    | 'invalid_session'
    | 'csrf_invalid'
    | 'forbidden'
    | 'not_found'
    | 'validation_failed'
    | 'conflict'
    | 'method_not_allowed'
    | 'route_not_found'
    | 'internal_error';
  readonly details: readonly { readonly field: string; readonly message: string }[] | undefined;

  constructor(
    status: number,
    code: AdminHttpErrorV1['code'],
    message: string,
    details?: readonly { readonly field: string; readonly message: string }[],
  ) {
    super(message);
    this.name = 'AdminHttpErrorV1';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response(): { readonly error: Record<string, unknown> } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

const SESSION_COOKIE = 'lotus_admin_session';
const CSRF_COOKIE = 'lotus_admin_csrf';
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{40,128}$/u;
const SAFE_COOKIE_NAME = /^[A-Za-z0-9_]{1,64}$/u;
const MAX_ROUTE_SEGMENTS = 8;
const MAX_ROUTE_LENGTH = 8_192;
const MAX_ADMIN_BODY_BYTES = 1_048_576;
const MAX_ADMIN_OBJECT_KEYS = 256;
const MAX_ADMIN_ARRAY_ITEMS = 512;
const MAX_ADMIN_JSON_DEPTH = 16;
const MAX_MANUAL_BLOCKS = 10_000;
const MAX_MANUAL_BLOCK_REASON = 500;
const MAX_SAFE_TIMESTAMP_LENGTH = 40;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SAFE_ERROR_CODES = new Set([
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
  'unsupported_currency',
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
  invalid_url: 'The calendar source URL is invalid.',
  insecure_protocol: 'The calendar source requires HTTPS.',
  blocked_host: 'The calendar source host is not allowed.',
  blocked_address: 'The calendar source resolved to a blocked network address.',
  dns_error: 'The calendar source could not be resolved.',
  dns_rebinding: 'The calendar source DNS resolution changed during validation.',
  redirect_limit: 'The calendar source exceeded the redirect limit.',
  redirect_location: 'The calendar source returned an invalid redirect.',
  timeout: 'The calendar source request timed out.',
  body_limit: 'The calendar source body exceeded the size limit.',
  invalid_encoding: 'The calendar source body encoding is invalid.',
  http_error: 'The calendar source returned an unsuccessful response.',
  network_error: 'The calendar source request failed.',
  missing_calendar: 'The calendar source returned malformed iCalendar data.',
  invalid_component: 'The calendar source returned malformed iCalendar data.',
  missing_event: 'The calendar source did not contain a usable event.',
  event_limit: 'The calendar source contained too many events.',
  duplicate_uid: 'The calendar source contained duplicate event identifiers.',
  ambiguous_timezone: 'The calendar source contained timezone-ambiguous event data.',
  invalid_date: 'The calendar source contained an invalid date.',
  invalid_interval: 'The calendar source contained an invalid stay interval.',
  invalid_input: 'The calendar source returned malformed iCalendar data.',
  invalid_line: 'The calendar source returned malformed iCalendar data.',
  line_too_long: 'The calendar source returned an oversized iCalendar line.',
  missing_property: 'The calendar source returned an incomplete event.',
  duplicate_property: 'The calendar source returned a duplicate event property.',
  invalid_uid: 'The calendar source returned an invalid event identifier.',
  invalid_sequence: 'The calendar source returned an invalid event version.',
  invalid_timestamp: 'The calendar source returned an invalid event timestamp.',
  invalid_status: 'The calendar source returned an unsupported event status.',
  text_too_long: 'The calendar source returned oversized event text.',
  availability_conflict: 'The calendar source could not update availability.',
  sync_failed: 'Calendar synchronization failed.',
});

type AdminRoute =
  | { readonly kind: 'login' }
  | { readonly kind: 'logout' }
  | { readonly kind: 'session' }
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'property'; readonly propertyId: string; readonly page: boolean }
  | { readonly kind: 'content'; readonly propertyId: string }
  | { readonly kind: 'rates'; readonly propertyId: string }
  | { readonly kind: 'manualBlocks'; readonly propertyId: string }
  | { readonly kind: 'bookingRequests'; readonly propertyId: string }
  | {
      readonly kind: 'manualBlock';
      readonly propertyId: string;
      readonly recordId: string;
    }
  | {
      readonly kind: 'icalHealth';
      readonly propertyId: string;
      readonly sourceId: string;
    }
  | {
      readonly kind: 'bookingRequest';
      readonly propertyId: string;
      readonly requestId: string;
      readonly action: 'get' | 'approve' | 'reject' | 'recheck';
    };

interface ParsedCookies {
  readonly [name: string]: string | undefined;
}

interface AdminPropertyResponseV1 extends AdminPagePropertyV1 {
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: PropertyConfigurationV1['propertyType'];
  readonly bedroomCount: number;
  readonly bedConfiguration: PropertyConfigurationV1['bedConfiguration'];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
}

interface AdminRatePlanResponseV1 {
  readonly currency: string;
  readonly baseNightlyRateMinor: number;
  readonly cleaningFeeMinor: number;
  readonly minimumStayNights: number;
  readonly seasonalOverrides: readonly {
    readonly arrival: string;
    readonly departure: string;
    readonly nightlyRateMinor: number;
  }[];
}

interface AdminManualBlockResponseV1 {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: 'manual';
  readonly status: AvailabilityRecordV1['status'];
  readonly arrival: string;
  readonly departure: string;
  readonly expiresAt: string | null;
  readonly reason: string | null;
}

interface AdminUserResponseV1 {
  readonly id: string;
  readonly email: string;
  readonly role: AdminRoleV1;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedJsonValue(
  value: unknown,
  depth: number,
  state: { bytes: number; readonly seen: Set<object> },
): boolean {
  if (depth > MAX_ADMIN_JSON_DEPTH) {
    return false;
  }
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value);
    return state.bytes <= MAX_ADMIN_BODY_BYTES;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean' || value === null) {
    return true;
  }
  if (typeof value !== 'object' || (!isPlainRecord(value) && !Array.isArray(value))) {
    return false;
  }
  if (state.seen.has(value)) {
    return false;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ADMIN_ARRAY_ITEMS) {
        return false;
      }
      return value.every((entry) => boundedJsonValue(entry, depth + 1, state));
    }
    const keys = Reflect.ownKeys(value);
    const stringKeys = keys.filter((key): key is string => typeof key === 'string');
    if (keys.length > MAX_ADMIN_OBJECT_KEYS || stringKeys.length !== keys.length) {
      return false;
    }
    return stringKeys.every((key) => {
      if (key.length > 128 || hasControlCharacters(key)) {
        return false;
      }
      return boundedJsonValue(value[key], depth + 1, state);
    });
  } finally {
    state.seen.delete(value);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value) || !boundedJsonValue(value, 0, { bytes: 0, seen: new Set() })) {
    throw new AdminHttpErrorV1(400, 'validation_failed', 'Request validation failed.');
  }
  return value;
}

function recordForCsrf(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function parseCookies(value: string | undefined): ParsedCookies {
  const cookies: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  if (value === undefined || value.length > 8_192) {
    return cookies;
  }
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const content = part.slice(separator + 1).trim();
    if (!SAFE_COOKIE_NAME.test(name)) {
      continue;
    }
    if (seen.has(name)) {
      cookies[name] = undefined;
      continue;
    }
    seen.add(name);
    cookies[name] = SAFE_TOKEN.test(content) ? content : undefined;
  }
  return cookies;
}

function tokenEqual(left: string | undefined, right: string | undefined): boolean {
  if (
    left === undefined ||
    right === undefined ||
    !SAFE_TOKEN.test(left) ||
    !SAFE_TOKEN.test(right)
  ) {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookie(
  name: string,
  value: string,
  options: { readonly secure: boolean; readonly httpOnly: boolean; readonly maxAge: number },
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Strict',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${options.maxAge}`,
  ].join('; ');
}

function clearedCookie(name: string, secure: boolean, httpOnly: boolean): string {
  return cookie(name, '', { secure, httpOnly, maxAge: 0 });
}

function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

function response(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string | readonly string[]>>,
): AdminHttpResponseV1 {
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

function errorResponse(error: unknown): AdminHttpResponseV1 {
  if (error instanceof AdminHttpErrorV1) {
    return response(error.status, { ...error.response() });
  }
  return response(500, {
    error: {
      code: 'internal_error',
      message: 'The admin request could not be completed.',
    },
  });
}

function notFound(): never {
  throw new AdminHttpErrorV1(404, 'not_found', 'The requested admin resource was not found.');
}

function methodNotAllowed(): never {
  throw new AdminHttpErrorV1(405, 'method_not_allowed', 'Method is not allowed for this route.');
}

function fieldDetails(
  errors: readonly {
    readonly field?: unknown;
    readonly code?: unknown;
  }[],
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

function validationError(
  details?: readonly { readonly field?: unknown; readonly code?: unknown }[],
): never {
  throw new AdminHttpErrorV1(
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

function mapPersistenceError(error: unknown): AdminHttpErrorV1 {
  const code = persistenceErrorCode(error);
  if (
    code === 'property_not_found' ||
    code === 'booking_request_not_found' ||
    code === 'rate_plan_not_found' ||
    code === 'organization_not_found' ||
    code === 'invalid_organization_id' ||
    code === 'invalid_property_id'
  ) {
    return new AdminHttpErrorV1(404, 'not_found', 'The requested admin resource was not found.');
  }
  if (
    code === 'availability_conflict' ||
    code === 'invalid_booking_request_transition' ||
    code === 'booking_request_expired'
  ) {
    return new AdminHttpErrorV1(409, 'conflict', 'The admin operation could not be applied.');
  }
  if (
    code !== undefined &&
    (code.endsWith('_validation') ||
      code.startsWith('invalid_') ||
      code === 'rate_validation' ||
      code === 'invalid_stay')
  ) {
    const record = error as Record<string, unknown>;
    const errors = record['errors'];
    return new AdminHttpErrorV1(
      400,
      'validation_failed',
      'Request validation failed.',
      Array.isArray(errors) ? fieldDetails(errors) : undefined,
    );
  }
  return new AdminHttpErrorV1(500, 'internal_error', 'The admin request could not be completed.');
}

function route(path: string): AdminRoute | undefined {
  if (typeof path !== 'string' || path.length > MAX_ROUTE_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(path, 'https://lotus-booking.invalid');
  } catch {
    return undefined;
  }
  const parts = url.pathname.split('/');
  if (parts.some((part, index) => index > 0 && part.length === 0)) {
    return undefined;
  }
  const nonEmptyParts = parts.filter((part) => part.length > 0);
  if (
    nonEmptyParts.length === 0 ||
    nonEmptyParts[0] !== 'admin' ||
    nonEmptyParts.length > MAX_ROUTE_SEGMENTS
  ) {
    return undefined;
  }
  const decoded: string[] = [];
  try {
    for (const part of nonEmptyParts) {
      const value = decodeURIComponent(part);
      if (value.length > 512) {
        return undefined;
      }
      decoded.push(value);
    }
  } catch {
    return undefined;
  }
  if (decoded.length === 2 && decoded[1] === 'login') {
    return { kind: 'login' };
  }
  if (decoded.length === 2 && decoded[1] === 'logout') {
    return { kind: 'logout' };
  }
  if (decoded.length === 2 && decoded[1] === 'session') {
    return { kind: 'session' };
  }
  if (decoded.length === 1) {
    return { kind: 'dashboard' };
  }
  if (decoded.length < 3 || decoded[1] !== 'properties') {
    return undefined;
  }
  const propertyId = decoded[2];
  if (propertyId === undefined) {
    return undefined;
  }
  if (decoded.length === 3) {
    return { kind: 'property', propertyId, page: false };
  }
  if (decoded.length === 4 && decoded[3] === 'page') {
    return { kind: 'property', propertyId, page: true };
  }
  if (decoded.length === 4 && (decoded[3] === 'content' || decoded[3] === 'notes')) {
    return { kind: 'content', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'rates') {
    return { kind: 'rates', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'manual-blocks') {
    return { kind: 'manualBlocks', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'booking-requests') {
    return { kind: 'bookingRequests', propertyId };
  }
  if (decoded.length === 5 && decoded[3] === 'manual-blocks' && decoded[4] !== undefined) {
    return { kind: 'manualBlock', propertyId, recordId: decoded[4] };
  }
  if (
    decoded.length === 6 &&
    (decoded[3] === 'ical' || decoded[3] === 'ical-sources' || decoded[3] === 'ical-sync') &&
    decoded[5] === 'health' &&
    decoded[4] !== undefined
  ) {
    return { kind: 'icalHealth', propertyId, sourceId: decoded[4] };
  }
  if (
    decoded.length === 6 &&
    decoded[3] === 'booking-requests' &&
    decoded[4] !== undefined &&
    decoded[5] !== undefined
  ) {
    const action = decoded[5];
    if (action === 'approve' || action === 'reject') {
      return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action };
    }
    if (action === 'recheck' || action === 'recheck-availability') {
      return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action: 'recheck' };
    }
  }
  if (decoded.length === 5 && decoded[3] === 'booking-requests' && decoded[4] !== undefined) {
    return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action: 'get' };
  }
  return undefined;
}

function validIdentifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    validationError([{ field, code: 'malformed_id' }]);
  }
  return value;
}

function scopeFor(session: AdminSessionV1): OrganizationScope {
  return Object.freeze({ organizationId: session.organizationId });
}

function propertyInput(property: PropertyConfigurationV1): PropertyConfigurationInputV1 {
  return {
    id: property.id,
    name: property.name,
    summary: property.summary,
    country: property.country,
    timezone: property.timezone,
    currency: property.currency,
    propertyType: property.propertyType,
    bedroomCount: property.bedroomCount,
    bedConfiguration: property.bedConfiguration.map((bed) => ({
      type: bed.type,
      quantity: bed.quantity,
    })),
    bathroomCount: property.bathroomCount,
    maximumGuests: property.maximumGuests,
    amenities: [...property.amenities],
    hostNotes: property.hostNotes,
    operationalNotes: property.operationalNotes,
  };
}

function serializeProperty(property: PropertyConfigurationV1): AdminPropertyResponseV1 {
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

function pageData(property: PropertyConfigurationV1): AdminPagePropertyV1 {
  return {
    id: property.id,
    name: property.name,
    summary: property.summary,
    hostNotes: property.hostNotes,
    operationalNotes: property.operationalNotes,
  };
}

function serializeRatePlan(plan: RatePlanV1): AdminRatePlanResponseV1 {
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

function serializeManualBlock(
  block: AvailabilityRecordV1,
  propertyId: string,
): AdminManualBlockResponseV1 {
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

function serializeQuote(quote: QuoteBreakdownV1): QuoteBreakdownV1 {
  return Object.freeze({
    arrival: quote.arrival,
    departure: quote.departure,
    nights: quote.nights,
    currency: quote.currency,
    nightly: Object.freeze(
      quote.nightly.map((night) =>
        Object.freeze({
          date: night.date,
          amountMinor: night.amountMinor,
          source: night.source,
        }),
      ),
    ),
    nightlySubtotalMinor: quote.nightlySubtotalMinor,
    cleaningFeeMinor: quote.cleaningFeeMinor,
    totalMinor: quote.totalMinor,
    minimumStayNights: quote.minimumStayNights,
  });
}

function serializeBookingRequest(request: BookingRequestRecordV1): Record<string, unknown> {
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

function serializeUser(user: AdminSessionUserV1): AdminUserResponseV1 {
  return Object.freeze({
    id: user.id,
    email: user.email,
    role: user.role,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function defaultPropertyPage(property: AdminPagePropertyV1, csrfToken: string): string {
  const safeId = escapeHtml(property.id);
  const encodedId = encodeURIComponent(property.id);
  const safeCsrf = escapeHtml(csrfToken);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="csrf-token" content="${safeCsrf}"><title>${escapeHtml(property.name)} · Lotus Booking admin</title></head><body><main data-admin-property="${safeId}"><h1>${escapeHtml(property.name)}</h1><p>${escapeHtml(property.summary)}</p><section><h2>Guest-visible host notes</h2><p data-public-note>${escapeHtml(property.hostNotes)}</p></section><form method="post" action="/admin/properties/${encodedId}/content"><input type="hidden" name="csrfToken" value="${safeCsrf}"><label>Property name<input name="name" maxlength="120" value="${escapeHtml(property.name)}" required></label><label>Summary<textarea name="summary" maxlength="500" required>${escapeHtml(property.summary)}</textarea></label><label>Private operational notes<textarea name="operationalNotes" maxlength="4000" required>${escapeHtml(property.operationalNotes)}</textarea></label><button type="submit">Save property</button></form><nav><a href="/admin/properties/${encodedId}/rates">Rates</a><a href="/admin/properties/${encodedId}/manual-blocks">Manual blocks</a><a href="/admin/properties/${encodedId}/booking-requests">Booking requests</a></nav></main></body></html>`;
}

function normalizedOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new TypeError('admin origin must be an exact HTTP(S) origin.');
  }
}

function originFromHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const host = headerValue(headers, 'host');
  if (host === undefined || host.length === 0 || /[\s\r\n,]/u.test(host)) {
    return undefined;
  }
  try {
    // A forwarded protocol is only trusted when the deployment supplies an exact
    // expected origin. Otherwise a client-controlled header must not widen CSRF trust.
    return new URL(`http://${host}`).origin;
  } catch {
    return undefined;
  }
}

function parseOriginHeader(value: string | undefined): string | undefined {
  if (value === undefined || value === 'null' || /[\s\r\n,]/u.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function sameOrigin(
  headers: Readonly<Record<string, string>> | undefined,
  expectedOrigin: string | undefined,
): boolean {
  const originHeader = headerValue(headers, 'origin');
  if (originHeader !== undefined) {
    const origin = parseOriginHeader(originHeader);
    if (origin === undefined) {
      return false;
    }
    return origin === (expectedOrigin ?? originFromHeaders(headers));
  }
  const referer = headerValue(headers, 'referer');
  if (referer !== undefined) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return false;
    }
    return refererOrigin === (expectedOrigin ?? originFromHeaders(headers));
  }
  // The in-process API has no browser origin context. The real server still validates
  // Origin/Referer whenever a user agent supplies either header.
  return expectedOrigin === undefined;
}

function requestCsrfToken(
  request: AdminHttpRequestV1,
  body: Record<string, unknown> | undefined,
): string | undefined {
  const header = headerValue(request.headers, 'x-csrf-token');
  const formToken = body?.['csrfToken'];
  const form = typeof formToken === 'string' ? formToken : undefined;
  if (header !== undefined && form !== undefined && !tokenEqual(header, form)) {
    return undefined;
  }
  return header ?? form;
}

function bodyWithoutCsrf(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(body, 'csrfToken')) {
    return body;
  }
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'csrfToken'));
}

async function requireCsrf(
  request: AdminHttpRequestV1,
  session: AdminSessionV1 | null,
  sessionStore: AdminSessionStoreV1,
  sessionToken: string | undefined,
  cookies: ParsedCookies,
  body: Record<string, unknown> | undefined,
  expectedOrigin: string | undefined,
): Promise<void> {
  if (!sameOrigin(request.headers, expectedOrigin)) {
    throw new AdminHttpErrorV1(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  const cookieToken = cookies[CSRF_COOKIE];
  const candidate = requestCsrfToken(request, body);
  if (!tokenEqual(candidate, cookieToken)) {
    throw new AdminHttpErrorV1(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  if (session?.csrfToken !== undefined && !tokenEqual(candidate, session.csrfToken)) {
    throw new AdminHttpErrorV1(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  if (session !== null && session.csrfToken === undefined) {
    const verifyCsrf = sessionStore.verifyCsrf;
    if (
      verifyCsrf === undefined ||
      sessionToken === undefined ||
      !(await verifyCsrf(sessionToken, candidate as string))
    ) {
      throw new AdminHttpErrorV1(403, 'csrf_invalid', 'The admin request could not be verified.');
    }
  }
}

function requireAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const invalid = Object.keys(record).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    validationError(invalid.slice(0, 32).map((field) => ({ field, code: 'unknown_field' })));
  }
}

function requireNoBodyFields(body: Record<string, unknown>): void {
  if (Object.keys(body).length > 0) {
    validationError([{ field: 'body', code: 'unknown_field' }]);
  }
}

function requirePrivateRead(session: AdminSessionV1): void {
  if (session.role === 'viewer') {
    throw new AdminHttpErrorV1(403, 'forbidden', 'This admin role is not permitted.');
  }
}

function requireMutation(session: AdminSessionV1): void {
  if (session.role === 'viewer') {
    throw new AdminHttpErrorV1(403, 'forbidden', 'This admin role is not permitted.');
  }
}

function requireBookingMutation(session: AdminSessionV1): void {
  if (session.role !== 'owner' && session.role !== 'admin') {
    throw new AdminHttpErrorV1(403, 'forbidden', 'This admin role is not permitted.');
  }
}

async function requireSession(
  store: AdminSessionStoreV1,
  request: AdminHttpRequestV1,
): Promise<{
  readonly token: string;
  readonly session: AdminSessionV1;
  readonly cookies: ParsedCookies;
}> {
  const cookies = parseCookies(headerValue(request.headers, 'cookie'));
  const token = cookies[SESSION_COOKIE];
  if (token === undefined) {
    throw new AdminHttpErrorV1(401, 'invalid_session', 'A valid admin session is required.');
  }
  const session = await store.get(token);
  if (session === null) {
    throw new AdminHttpErrorV1(401, 'invalid_session', 'A valid admin session is required.');
  }
  return { token, session, cookies };
}

function canonicalProperty(property: PropertyConfigurationV1): PropertyConfigurationV1 {
  const result = createPropertyConfigurationV1(propertyInput(property));
  if (!result.ok) {
    throw new Error('property repository returned invalid configuration.');
  }
  return result.value;
}

async function loadProperty(
  dependencies: AdminHttpApiDependenciesV1,
  session: AdminSessionV1,
  propertyId: string,
): Promise<PropertyConfigurationV1> {
  const id = validIdentifier(propertyId, 'propertyId');
  try {
    const property = await dependencies.properties.findById(scopeFor(session), id);
    if (property === null || property.id !== id) {
      notFound();
    }
    return canonicalProperty(property);
  } catch (error) {
    if (error instanceof AdminHttpErrorV1) {
      throw error;
    }
    throw mapPersistenceError(error);
  }
}

const PROPERTY_FIELDS = new Set([
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
  'operationalNotes',
]);
const CONTENT_FIELDS = new Set(['name', 'summary', 'hostNotes', 'operationalNotes']);
const RATE_FIELDS = new Set([
  'currency',
  'baseNightlyRateMinor',
  'cleaningFeeMinor',
  'minimumStayNights',
  'seasonalOverrides',
]);
const RATE_OVERRIDE_FIELDS = new Set(['arrival', 'departure', 'nightlyRateMinor']);
const MANUAL_BLOCK_FIELDS = new Set(['id', 'arrival', 'departure', 'reason']);

function propertyUpdateInput(
  property: PropertyConfigurationV1,
  body: Record<string, unknown>,
): PropertyConfigurationInputV1 {
  const keys = Object.keys(body);
  if (keys.length === 0) {
    validationError([{ field: 'body', code: 'invalid_input' }]);
  }
  const isContentUpdate = keys.every((key) => CONTENT_FIELDS.has(key));
  const isFullUpdate = keys.every((key) => PROPERTY_FIELDS.has(key));
  if (!isContentUpdate && !isFullUpdate) {
    requireAllowedKeys(body, PROPERTY_FIELDS);
    validationError([{ field: 'body', code: 'invalid_input' }]);
  }
  const input: Record<string, unknown> = isContentUpdate
    ? { ...propertyInput(property) }
    : { ...body };
  if (isContentUpdate) {
    for (const field of keys) {
      input[field] = body[field] as never;
    }
  }
  requireAllowedKeys(input, PROPERTY_FIELDS);
  return input as unknown as PropertyConfigurationInputV1;
}

function validatePropertyUpdate(
  property: PropertyConfigurationV1,
  body: Record<string, unknown>,
): PropertyConfigurationInputV1 {
  const input = propertyUpdateInput(property, body);
  const result = createPropertyConfigurationV1(input);
  if (!result.ok) {
    validationError(result.errors);
  }
  if (result.value.id !== property.id) {
    validationError([{ field: 'id', code: 'malformed_id' }]);
  }
  return input;
}

function validateRateInput(body: Record<string, unknown>): RatePlanV1 {
  requireAllowedKeys(body, RATE_FIELDS);
  const rawOverrides = body['seasonalOverrides'];
  if (rawOverrides !== undefined) {
    if (!Array.isArray(rawOverrides)) {
      validationError([{ field: 'seasonalOverrides', code: 'invalid_array' }]);
    }
    for (const [index, override] of rawOverrides.entries()) {
      if (!isPlainRecord(override)) {
        validationError([{ field: `seasonalOverrides[${index}]`, code: 'invalid_input' }]);
      }
      requireAllowedKeys(override, RATE_OVERRIDE_FIELDS);
    }
  }
  const result = createRatePlanV1(body);
  if (!result.ok) {
    validationError(result.errors);
  }
  return result.value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function validateManualBlockInput(body: Record<string, unknown>): {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
  readonly reason: string;
} {
  requireAllowedKeys(body, MANUAL_BLOCK_FIELDS);
  const id = body['id'];
  const arrival = body['arrival'];
  const departure = body['departure'];
  const reason = body['reason'];
  if (typeof id !== 'string' || !SAFE_IDENTIFIER.test(id)) {
    validationError([{ field: 'id', code: 'malformed_id' }]);
  }
  if (
    typeof arrival !== 'string' ||
    typeof departure !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(arrival) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(departure)
  ) {
    validationError([{ field: 'interval', code: 'invalid_stay' }]);
  }
  const dateResult = createLocalDateIntervalV1({ arrival, departure });
  if (!dateResult.ok) {
    validationError([{ field: 'interval', code: 'invalid_stay' }]);
  }
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > MAX_MANUAL_BLOCK_REASON ||
    hasControlCharacters(reason)
  ) {
    validationError([{ field: 'reason', code: 'invalid_string' }]);
  }
  return {
    id,
    arrival,
    departure,
    reason: reason.trim(),
  };
}

function safeTimestamp(value: string | null): string | null {
  return value !== null &&
    typeof value === 'string' &&
    value.length <= MAX_SAFE_TIMESTAMP_LENGTH &&
    SAFE_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function serializeHealth(sourceId: string, result: ICalSyncHealth): Record<string, unknown> {
  const error =
    result.error === null
      ? null
      : {
          code: Object.prototype.hasOwnProperty.call(SAFE_ICAL_ERRORS, result.error.code)
            ? result.error.code
            : 'sync_failed',
          message:
            SAFE_ICAL_ERRORS[
              Object.prototype.hasOwnProperty.call(SAFE_ICAL_ERRORS, result.error.code)
                ? result.error.code
                : 'sync_failed'
            ],
        };
  return Object.freeze({
    sourceId,
    lastAttemptAt: safeTimestamp(result.lastAttemptAt),
    lastSuccessAt: safeTimestamp(result.lastSuccessAt),
    stale: result.stale === true,
    error,
  });
}

function scopedBookingRequest(
  request: BookingRequestRecordV1 | null,
  session: AdminSessionV1,
  propertyId: string,
  requestId: string,
): BookingRequestRecordV1 {
  if (
    request === null ||
    request.id !== requestId ||
    request.propertyId !== propertyId ||
    request.organizationId !== session.organizationId
  ) {
    notFound();
  }
  return request;
}

function normalizeExpectedOrigin(options: AdminHttpApiOptionsV1): string | undefined {
  return normalizedOrigin(options.origin);
}

export function createAdminHttpApiV1(
  dependencies: AdminHttpApiDependenciesV1,
  options: AdminHttpApiOptionsV1 = {},
): AdminHttpApiV1 {
  const secureCookies = options.secureCookies ?? true;
  const expectedOrigin = normalizeExpectedOrigin(options);
  const sessions = options.sessionStore ?? createAdminSessionStoreV1(options.session);
  const sessionMaxAge = Math.floor(8 * 60 * 60);

  function setCsrfCookie(token: string): string {
    return cookie(CSRF_COOKIE, token, {
      secure: secureCookies,
      httpOnly: false,
      maxAge: sessionMaxAge,
    });
  }

  function csrfCookieHeaders(
    session: AdminSessionV1,
    cookies: ParsedCookies,
  ): Readonly<Record<string, string>> {
    const token = session.csrfToken ?? cookies[CSRF_COOKIE];
    if (token === undefined) {
      throw new AdminHttpErrorV1(401, 'invalid_session', 'A valid admin session is required.');
    }
    return { 'set-cookie': setCsrfCookie(token) };
  }

  function sessionCookies(ticket: {
    readonly token: string;
    readonly csrfToken: string;
  }): readonly string[] {
    return [
      cookie(SESSION_COOKIE, ticket.token, {
        secure: secureCookies,
        httpOnly: true,
        maxAge: sessionMaxAge,
      }),
      setCsrfCookie(ticket.csrfToken),
    ];
  }

  async function requireCsrfThenRecord(
    request: AdminHttpRequestV1,
    session: AdminSessionV1,
    cookies: ParsedCookies,
  ): Promise<Record<string, unknown>> {
    await requireCsrf(
      request,
      session,
      sessions,
      cookies[SESSION_COOKIE],
      cookies,
      recordForCsrf(request.body),
      expectedOrigin,
    );
    return requireRecord(request.body);
  }

  async function handleLogin(request: AdminHttpRequestV1): Promise<AdminHttpResponseV1> {
    if (request.method === 'GET') {
      const csrf = newCsrfToken();
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lotus Booking admin login</title></head><body><main data-admin-login><h1>Lotus Booking admin</h1><form method="post" action="/admin/login"><input type="hidden" name="csrfToken" value="${escapeHtml(csrf)}"><label>Email<input name="email" type="email" maxlength="254" required></label><label>Password<input name="password" type="password" maxlength="256" required></label><button type="submit">Sign in</button></form></main></body></html>`;
      return response(200, html, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'set-cookie': setCsrfCookie(csrf),
      });
    }
    if (request.method !== 'POST') {
      methodNotAllowed();
    }
    await requireCsrf(
      request,
      null,
      sessions,
      undefined,
      parseCookies(headerValue(request.headers, 'cookie')),
      recordForCsrf(request.body),
      expectedOrigin,
    );
    const body = requireRecord(request.body);
    requireAllowedKeys(body, new Set(['csrfToken', 'email', 'password']));
    const email = body['email'];
    const password = body['password'];
    const user = await authenticateOwnerV1(dependencies.credentials, email, password);
    if (user === null) {
      throw new AdminHttpErrorV1(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const oldToken = parseCookies(headerValue(request.headers, 'cookie'))[SESSION_COOKIE];
    if (oldToken !== undefined) {
      await sessions.destroy(oldToken);
    }
    const ticket = await sessions.create(user);
    return response(
      200,
      { user: serializeUser(ticket.session) },
      {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': sessionCookies(ticket),
      },
    );
  }

  return {
    async handle(request): Promise<AdminHttpResponseV1> {
      const method = request.method.toUpperCase();
      const normalizedRequest: AdminHttpRequestV1 = { ...request, method };
      const parsedRoute = route(request.path);
      if (parsedRoute === undefined) {
        return errorResponse(
          new AdminHttpErrorV1(404, 'route_not_found', 'Admin route was not found.'),
        );
      }
      try {
        if (parsedRoute.kind === 'login') {
          return await handleLogin(normalizedRequest);
        }

        const authenticated = await requireSession(sessions, normalizedRequest);
        const { session, token, cookies } = authenticated;

        if (parsedRoute.kind === 'logout') {
          if (method !== 'POST') {
            methodNotAllowed();
          }
          if (request.body !== undefined) {
            const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          await sessions.destroy(token);
          return response(204, undefined, {
            'set-cookie': [
              clearedCookie(SESSION_COOKIE, secureCookies, true),
              clearedCookie(CSRF_COOKIE, secureCookies, false),
            ],
          });
        }

        if (parsedRoute.kind === 'session') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          return response(200, { user: serializeUser(session), expiresAt: session.expiresAt });
        }

        if (parsedRoute.kind === 'dashboard') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          return response(
            200,
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lotus Booking admin</title></head><body><main data-admin-dashboard><h1>Lotus Booking admin</h1><p>${escapeHtml(session.email)}</p><p data-admin-role>${escapeHtml(session.role)}</p></main></body></html>`,
            {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy':
                "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
              ...csrfCookieHeaders(session, cookies),
            },
          );
        }

        requirePrivateRead(session);

        if (parsedRoute.kind === 'property') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method !== 'GET') {
            methodNotAllowed();
          }
          if (parsedRoute.page) {
            const csrfToken = session.csrfToken ?? cookies[CSRF_COOKIE];
            if (csrfToken === undefined) {
              throw new AdminHttpErrorV1(
                401,
                'invalid_session',
                'A valid admin session is required.',
              );
            }
            const html =
              options.renderPropertyPage?.({
                property: pageData(property),
                csrfToken,
              }) ?? defaultPropertyPage(pageData(property), csrfToken);
            return response(200, html, {
              'content-type': 'text/html; charset=utf-8',
              'content-security-policy':
                "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
              ...csrfCookieHeaders(session, cookies),
            });
          }
          return response(200, serializeProperty(property));
        }

        if (parsedRoute.kind === 'content') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method !== 'PUT' && method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const input = validatePropertyUpdate(property, bodyWithoutCsrf(body));
          const updated = await dependencies.properties.update(
            scopeFor(session),
            property.id,
            input,
          );
          if (updated === null) {
            notFound();
          }
          return response(200, serializeProperty(canonicalProperty(updated)));
        }

        if (parsedRoute.kind === 'rates') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method === 'GET') {
            const plan = await dependencies.rates.getRatePlan(scopeFor(session), property.id);
            if (plan === null) {
              notFound();
            }
            return response(200, serializeRatePlan(plan));
          }
          if (method !== 'PUT' && method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const plan = validateRateInput(bodyWithoutCsrf(body));
          const saved = await dependencies.rates.saveRatePlan(scopeFor(session), property.id, plan);
          return response(200, serializeRatePlan(saved));
        }

        if (parsedRoute.kind === 'manualBlocks') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (method === 'GET') {
            const blocks = await dependencies.availability.listManualBlocks(
              scopeFor(session),
              property.id,
            );
            if (!Array.isArray(blocks) || blocks.length > MAX_MANUAL_BLOCKS) {
              throw new AdminHttpErrorV1(
                500,
                'internal_error',
                'The admin request could not be completed.',
              );
            }
            return response(200, {
              blocks: Object.freeze(
                blocks.map((block) => serializeManualBlock(block, property.id)),
              ),
            });
          }
          if (method !== 'POST') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body = await requireCsrfThenRecord(normalizedRequest, session, cookies);
          const input = validateManualBlockInput(bodyWithoutCsrf(body));
          const created = await dependencies.availability.createManualBlock(
            scopeFor(session),
            property.id,
            input,
          );
          return response(201, serializeManualBlock(created, property.id));
        }

        if (parsedRoute.kind === 'bookingRequests') {
          if (method !== 'GET') {
            methodNotAllowed();
          }
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          if (dependencies.bookingRequests.list === undefined) {
            throw new AdminHttpErrorV1(
              500,
              'internal_error',
              'The admin request could not be completed.',
            );
          }
          const requests = await dependencies.bookingRequests.list(scopeFor(session), property.id);
          if (!Array.isArray(requests) || requests.length > MAX_MANUAL_BLOCKS) {
            throw new AdminHttpErrorV1(
              500,
              'internal_error',
              'The admin request could not be completed.',
            );
          }
          return response(200, {
            requests: Object.freeze(
              requests.map((entry) =>
                serializeBookingRequest(
                  scopedBookingRequest(entry, session, property.id, entry.id),
                ),
              ),
            ),
          });
        }

        if (parsedRoute.kind === 'manualBlock') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const recordId = validIdentifier(parsedRoute.recordId, 'recordId');
          if (method !== 'DELETE') {
            methodNotAllowed();
          }
          requireMutation(session);
          const body =
            request.body === undefined
              ? undefined
              : await requireCsrfThenRecord(normalizedRequest, session, cookies);
          if (body !== undefined) {
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          const released = await dependencies.availability.releaseManualBlock(
            scopeFor(session),
            property.id,
            recordId,
          );
          if (!released) {
            notFound();
          }
          return response(204, undefined);
        }

        if (parsedRoute.kind === 'icalHealth') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const sourceId = validIdentifier(parsedRoute.sourceId, 'sourceId');
          if (method !== 'GET') {
            methodNotAllowed();
          }
          const result = await dependencies.ical.health(
            Object.freeze({ organizationId: session.organizationId, propertyId: property.id }),
            sourceId,
          );
          return response(200, serializeHealth(sourceId, result));
        }

        if (parsedRoute.kind === 'bookingRequest') {
          const property = await loadProperty(dependencies, session, parsedRoute.propertyId);
          const requestId = validIdentifier(parsedRoute.requestId, 'requestId');
          if (parsedRoute.action === 'get') {
            if (method !== 'GET') {
              methodNotAllowed();
            }
            const found = await dependencies.bookingRequests.find(
              scopeFor(session),
              property.id,
              requestId,
            );
            return response(
              200,
              serializeBookingRequest(scopedBookingRequest(found, session, property.id, requestId)),
            );
          }
          if (method !== 'POST') {
            methodNotAllowed();
          }
          requireBookingMutation(session);
          const body =
            request.body === undefined
              ? undefined
              : await requireCsrfThenRecord(normalizedRequest, session, cookies);
          if (body !== undefined) {
            requireNoBodyFields(bodyWithoutCsrf(body));
          } else {
            await requireCsrf(
              normalizedRequest,
              session,
              sessions,
              token,
              cookies,
              undefined,
              expectedOrigin,
            );
          }
          if (parsedRoute.action === 'recheck') {
            const result = await dependencies.bookingRequests.recheckAvailability(
              scopeFor(session),
              property.id,
              requestId,
            );
            if (typeof result.available !== 'boolean') {
              throw new AdminHttpErrorV1(
                500,
                'internal_error',
                'The admin request could not be completed.',
              );
            }
            return response(200, {
              request: serializeBookingRequest(
                scopedBookingRequest(result.request, session, property.id, requestId),
              ),
              available: result.available,
            });
          }
          const saved =
            parsedRoute.action === 'approve'
              ? await dependencies.bookingRequests.approve(
                  scopeFor(session),
                  property.id,
                  requestId,
                )
              : await dependencies.bookingRequests.reject(
                  scopeFor(session),
                  property.id,
                  requestId,
                );
          return response(
            200,
            serializeBookingRequest(scopedBookingRequest(saved, session, property.id, requestId)),
          );
        }

        return errorResponse(
          new AdminHttpErrorV1(404, 'route_not_found', 'Admin route was not found.'),
        );
      } catch (error) {
        return errorResponse(
          error instanceof AdminHttpErrorV1 ? error : mapPersistenceError(error),
        );
      }
    },
  };
}

export type { AdminCredentialRecordV1, AdminRoleV1, ICalSyncHealth, ICalSyncRunResult };
export { SESSION_COOKIE as ADMIN_SESSION_COOKIE_V1, CSRF_COOKIE as ADMIN_CSRF_COOKIE_V1 };
