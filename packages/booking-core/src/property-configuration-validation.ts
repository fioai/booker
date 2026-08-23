import type {
  PropertyValidationErrorCodeV1,
  PropertyValidationErrorV1,
  ResultV1,
} from './property-configuration-types.js';

export function addValidationErrorV1(
  errors: PropertyValidationErrorV1[],
  field: string,
  code: PropertyValidationErrorCodeV1,
  message: string,
): void {
  errors.push({ field, code, message });
}

export function failureV1<T>(
  errors: readonly PropertyValidationErrorV1[],
): ResultV1<T, PropertyValidationErrorV1> {
  return {
    ok: false,
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  };
}

export function successV1<T>(value: T): ResultV1<T, PropertyValidationErrorV1> {
  return { ok: true, value };
}

export function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwnV1(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readOwnV1(record: Record<string, unknown>, key: string): unknown {
  return hasOwnV1(record, key) ? record[key] : undefined;
}

export function addUnknownFieldErrorsV1(
  record: Record<string, unknown>,
  prefix: string,
  knownFields: ReadonlySet<string>,
  errors: PropertyValidationErrorV1[],
): void {
  for (const key of Reflect.ownKeys(record)) {
    const field = typeof key === 'string' ? key : '[symbol]';
    if (typeof key !== 'string' || !knownFields.has(key)) {
      addValidationErrorV1(
        errors,
        `${prefix}.${field}`,
        'unknown_field',
        `${prefix} contains an unknown field: ${field}.`,
      );
    }
  }
}

function exceedsCodePointLimitV1(value: string, maximum: number): boolean {
  let codePointCount = 0;

  for (let offset = 0; offset < value.length; ) {
    codePointCount += 1;
    if (codePointCount > maximum) {
      return true;
    }

    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }

  return false;
}

function hasForbiddenControlV1(value: string): boolean {
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) {
      return false;
    }

    if (
      (codePoint >= 0x0000 && codePoint <= 0x001f) ||
      (codePoint >= 0x007f && codePoint <= 0x009f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }

    offset += codePoint > 0xffff ? 2 : 1;
  }

  return false;
}

function isAsciiV1(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }

  return true;
}

export function readTextV1(
  value: unknown,
  field: string,
  maximum: number,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  if (value === undefined) {
    addValidationErrorV1(errors, field, 'missing_field', `${field} is required.`);
    return undefined;
  }

  if (typeof value !== 'string') {
    addValidationErrorV1(errors, field, 'invalid_string', `${field} must be a string.`);
    return undefined;
  }

  if (exceedsCodePointLimitV1(value, maximum)) {
    addValidationErrorV1(
      errors,
      field,
      'string_too_long',
      `${field} must be at most ${maximum} characters.`,
    );
    return undefined;
  }

  if (hasForbiddenControlV1(value)) {
    addValidationErrorV1(
      errors,
      field,
      'malformed_string',
      `${field} contains forbidden controls.`,
    );
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    addValidationErrorV1(errors, field, 'empty_string', `${field} must not be empty.`);
    return undefined;
  }

  return normalized;
}

export function readIdentifierV1(
  value: unknown,
  maximum: number,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  const identifier = readTextV1(value, 'id', maximum, errors);

  if (identifier !== undefined && typeof value === 'string' && value !== identifier) {
    addValidationErrorV1(errors, 'id', 'malformed_id', 'id must not have surrounding whitespace.');
    return undefined;
  }

  if (identifier !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(identifier)) {
    addValidationErrorV1(
      errors,
      'id',
      'malformed_id',
      'id must use only letters, numbers, hyphens, and underscores.',
    );
    return undefined;
  }

  return identifier;
}

export function readCountV1(
  value: unknown,
  field: string,
  maximum: number,
  errors: PropertyValidationErrorV1[],
): number | undefined {
  if (value === undefined) {
    addValidationErrorV1(errors, field, 'missing_field', `${field} is required.`);
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addValidationErrorV1(errors, field, 'invalid_count', `${field} must be a finite integer.`);
    return undefined;
  }

  if (value < 0) {
    addValidationErrorV1(errors, field, 'negative_count', `${field} must not be negative.`);
    return undefined;
  }

  if (value > maximum) {
    addValidationErrorV1(errors, field, 'count_too_large', `${field} must be at most ${maximum}.`);
    return undefined;
  }

  if (!Number.isSafeInteger(value)) {
    addValidationErrorV1(errors, field, 'invalid_count', `${field} must be a safe integer.`);
    return undefined;
  }

  return value;
}

function readAsciiCodeV1(
  value: unknown,
  field: string,
  length: number,
  malformedCode: PropertyValidationErrorCodeV1,
  unsupportedCode: PropertyValidationErrorCodeV1,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  const code = readTextV1(value, field, length, errors);
  if (code === undefined) {
    return undefined;
  }

  // This check intentionally precedes case normalization: some Unicode letters fold to ASCII.
  if (!isAsciiV1(code)) {
    addValidationErrorV1(errors, field, malformedCode, `${field} must contain ASCII letters only.`);
    return undefined;
  }

  const normalized = code.toUpperCase();
  const expectedShape = length === 2 ? /^[A-Z]{2}$/u : /^[A-Z]{3}$/u;
  if (!expectedShape.test(normalized)) {
    addValidationErrorV1(errors, field, malformedCode, `${field} has an invalid ISO code shape.`);
    return undefined;
  }

  if (!supportedCodes.has(normalized)) {
    addValidationErrorV1(errors, field, unsupportedCode, `${field} is not an active ISO code.`);
    return undefined;
  }

  return normalized;
}

export function readCountryV1(
  value: unknown,
  length: number,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  return readAsciiCodeV1(
    value,
    'country',
    length,
    'malformed_country',
    'unsupported_country',
    supportedCodes,
    errors,
  );
}

export function readCurrencyV1(
  value: unknown,
  length: number,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  return readAsciiCodeV1(
    value,
    'currency',
    length,
    'malformed_currency',
    'unsupported_currency',
    supportedCodes,
    errors,
  );
}
