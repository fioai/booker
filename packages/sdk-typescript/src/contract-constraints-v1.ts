export function deepFreezeV1<const Value extends object>(value: Value): Readonly<Value> {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    const nestedValue = value[key];
    if (typeof nestedValue === 'object' && nestedValue !== null) {
      deepFreezeV1(nestedValue);
    }
  }
  return Object.freeze(value);
}

/**
 * Counts Unicode code points without allocating an intermediate array.
 *
 * When `maximum` is supplied, the count stops at `maximum + 1` because callers
 * that enforce an upper bound do not need the exact excess length.
 */
export function countUnicodeCodePointsV1(
  value: string,
  maximum = Number.POSITIVE_INFINITY,
): number {
  let length = 0;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    length += 1;
    if (length > maximum) {
      return length;
    }
  }
  return length;
}

/** Maximum individual nightly or cleaning-fee amount in minor currency units. */
export const PUBLIC_MINOR_AMOUNT_MAXIMUM_V1 = 1_000_000_000;

export const PUBLIC_IDENTIFIER_PATTERN_V1 = '^[A-Za-z0-9][A-Za-z0-9_-]*(?![\\s\\S])';
/**
 * Body text must contain complete Unicode scalar values. The paired-surrogate
 * alternative keeps this pattern valid in regular-expression engines with or
 * without Unicode mode.
 */
export const PUBLIC_BOUNDED_TEXT_PATTERN_V1 =
  '^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
export const PUBLIC_NONBLANK_CONTROL_SAFE_TEXT_PATTERN_V1 =
  '^(?![\\s\\S]*[\\u0000-\\u001F\\u007F])(?=[\\s\\S]*\\S)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
/** Portable Idempotency-Key values are non-empty visible ASCII (U+0021 through U+007E). */
export const PUBLIC_IDEMPOTENCY_KEY_PATTERN_V1 = '^[!-~]+(?![\\s\\S])';

export const PUBLIC_BOOKING_TEXT_CONSTRAINTS_V1 = deepFreezeV1({
  guestName: {
    minLength: 1,
    maxLength: 120,
    pattern: PUBLIC_NONBLANK_CONTROL_SAFE_TEXT_PATTERN_V1,
  },
  message: {
    minLength: 1,
    maxLength: 2_000,
    pattern: PUBLIC_NONBLANK_CONTROL_SAFE_TEXT_PATTERN_V1,
  },
  idempotencyKey: {
    minLength: 1,
    maxLength: 128,
    pattern: PUBLIC_IDEMPOTENCY_KEY_PATTERN_V1,
  },
} as const);

export const PUBLIC_VALIDATION_ISSUE_FIELD_PATTERN_V1 =
  '^[A-Za-z][A-Za-z0-9_.\\[\\]-]*(?![\\s\\S])';

/** Bounds copied from the canonical property configuration contract. */
export const PUBLIC_PROPERTY_RESPONSE_BOUNDS_V1 = deepFreezeV1({
  id: { minLength: 1, maxLength: 64 },
  name: { minLength: 1, maxLength: 120 },
  summary: { minLength: 1, maxLength: 500 },
  country: { minLength: 2, maxLength: 2 },
  timezone: { minLength: 1, maxLength: 64 },
  currency: { minLength: 3, maxLength: 3 },
  bedroomCount: { minimum: 0, maximum: 100 },
  bedConfiguration: {
    minItems: 1,
    maxItems: 16,
    items: { properties: { quantity: { minimum: 1, maximum: 100 } } },
  },
  bathroomCount: { minimum: 1, maximum: 100 },
  maximumGuests: { minimum: 1, maximum: 200 },
  amenities: { maxItems: 32, items: { minLength: 1, maxLength: 80 } },
  hostNotes: { minLength: 1, maxLength: 2_000 },
} as const);

export const PUBLIC_VALIDATION_ISSUE_BOUNDS_V1 = deepFreezeV1({
  field: { minLength: 1, maxLength: 128 },
  message: { minLength: 1, maxLength: 2_000 },
} as const);

export const PUBLIC_API_ERROR_MESSAGE_BOUNDS_V1 = deepFreezeV1({
  minLength: 1,
  maxLength: 2_000,
} as const);

export const PUBLIC_API_ERROR_CODES_V1 = Object.freeze([
  'validation_failed',
  'property_not_found',
  'quote_unavailable',
  'stay_unavailable',
  'request_conflict',
  'route_not_found',
  'method_not_allowed',
  'internal_error',
] as const);

export const PUBLIC_BOOKING_REQUEST_STATUSES_V1 = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
] as const);

export const PUBLIC_VALIDATION_CODES_V1 = Object.freeze([
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
] as const);
