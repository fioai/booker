import type { PropertyValidationErrorCode, PropertyValidationError, Result } from './types.js';

export function addValidationError(
  errors: PropertyValidationError[],
  field: string,
  code: PropertyValidationErrorCode,
  message: string,
): void {
  errors.push({ field, code, message });
}

export function failure<T>(
  errors: readonly PropertyValidationError[],
): Result<T, PropertyValidationError> {
  return {
    ok: false,
    errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))),
  };
}

export function success<T>(value: T): Result<T, PropertyValidationError> {
  return { ok: true, value };
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readOwn(record: Record<string, unknown>, key: string): unknown {
  return hasOwn(record, key) ? record[key] : undefined;
}

export function addUnknownFieldErrors(
  record: Record<string, unknown>,
  prefix: string,
  knownFields: ReadonlySet<string>,
  errors: PropertyValidationError[],
): void {
  for (const key of Reflect.ownKeys(record)) {
    const field = typeof key === 'string' ? key : '[symbol]';
    if (typeof key !== 'string' || !knownFields.has(key)) {
      addValidationError(
        errors,
        `${prefix}.${field}`,
        'unknown_field',
        `${prefix} contains an unknown field: ${field}.`,
      );
    }
  }
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
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

function hasMalformedTextCodePoint(value: string): boolean {
  for (let offset = 0; offset < value.length; ) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) {
      return false;
    }

    // codePointAt combines a valid surrogate pair, so a returned surrogate is lone.
    if (
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
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

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }

  return true;
}

export function readText(
  value: unknown,
  field: string,
  maximum: number,
  errors: PropertyValidationError[],
): string | undefined {
  if (value === undefined) {
    addValidationError(errors, field, 'missing_field', `${field} is required.`);
    return undefined;
  }

  if (typeof value !== 'string') {
    addValidationError(errors, field, 'invalid_string', `${field} must be a string.`);
    return undefined;
  }

  if (exceedsCodePointLimit(value, maximum)) {
    addValidationError(
      errors,
      field,
      'string_too_long',
      `${field} must be at most ${maximum} characters.`,
    );
    return undefined;
  }

  if (hasMalformedTextCodePoint(value)) {
    addValidationError(
      errors,
      field,
      'malformed_string',
      `${field} contains incomplete Unicode characters or forbidden controls.`,
    );
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    addValidationError(errors, field, 'empty_string', `${field} must not be empty.`);
    return undefined;
  }

  return normalized;
}

export function readIdentifier(
  value: unknown,
  maximum: number,
  errors: PropertyValidationError[],
): string | undefined {
  const identifier = readText(value, 'id', maximum, errors);

  if (identifier !== undefined && typeof value === 'string' && value !== identifier) {
    addValidationError(errors, 'id', 'malformed_id', 'id must not have surrounding whitespace.');
    return undefined;
  }

  if (identifier !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(identifier)) {
    addValidationError(
      errors,
      'id',
      'malformed_id',
      'id must use only letters, numbers, hyphens, and underscores.',
    );
    return undefined;
  }

  return identifier;
}

export function readCount(
  value: unknown,
  field: string,
  maximum: number,
  errors: PropertyValidationError[],
): number | undefined {
  if (value === undefined) {
    addValidationError(errors, field, 'missing_field', `${field} is required.`);
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addValidationError(errors, field, 'invalid_count', `${field} must be a finite integer.`);
    return undefined;
  }

  if (value < 0) {
    addValidationError(errors, field, 'negative_count', `${field} must not be negative.`);
    return undefined;
  }

  if (value > maximum) {
    addValidationError(errors, field, 'count_too_large', `${field} must be at most ${maximum}.`);
    return undefined;
  }

  if (!Number.isSafeInteger(value)) {
    addValidationError(errors, field, 'invalid_count', `${field} must be a safe integer.`);
    return undefined;
  }

  return value;
}

function readAsciiCode(
  value: unknown,
  field: string,
  length: number,
  malformedCode: PropertyValidationErrorCode,
  unsupportedCode: PropertyValidationErrorCode,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationError[],
): string | undefined {
  const code = readText(value, field, length, errors);
  if (code === undefined) {
    return undefined;
  }

  // This check intentionally precedes case normalization: some Unicode letters fold to ASCII.
  if (!isAscii(code)) {
    addValidationError(errors, field, malformedCode, `${field} must contain ASCII letters only.`);
    return undefined;
  }

  const normalized = code.toUpperCase();
  const expectedShape = length === 2 ? /^[A-Z]{2}$/u : /^[A-Z]{3}$/u;
  if (!expectedShape.test(normalized)) {
    addValidationError(errors, field, malformedCode, `${field} has an invalid ISO code shape.`);
    return undefined;
  }

  if (!supportedCodes.has(normalized)) {
    addValidationError(errors, field, unsupportedCode, `${field} is not an active ISO code.`);
    return undefined;
  }

  return normalized;
}

export function readCountry(
  value: unknown,
  length: number,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationError[],
): string | undefined {
  return readAsciiCode(
    value,
    'country',
    length,
    'malformed_country',
    'unsupported_country',
    supportedCodes,
    errors,
  );
}

export function readCurrency(
  value: unknown,
  length: number,
  supportedCodes: ReadonlySet<string>,
  errors: PropertyValidationError[],
): string | undefined {
  return readAsciiCode(
    value,
    'currency',
    length,
    'malformed_currency',
    'unsupported_currency',
    supportedCodes,
    errors,
  );
}
