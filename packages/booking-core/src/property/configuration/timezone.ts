import type { PropertyValidationError } from './types.js';
import { addValidationError, readText } from './validation.js';

function isIanaTimezoneShape(value: string): boolean {
  return /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/u.test(value);
}

export function readTimezone(
  value: unknown,
  maximum: number,
  errors: PropertyValidationError[],
): string | undefined {
  const timezone = readText(value, 'timezone', maximum, errors);
  if (timezone === undefined) {
    return undefined;
  }

  if (!isIanaTimezoneShape(timezone)) {
    addValidationError(
      errors,
      'timezone',
      'malformed_timezone',
      'timezone must be an IANA identifier.',
    );
    return undefined;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    addValidationError(
      errors,
      'timezone',
      'unsupported_timezone',
      'timezone is not supported by the runtime.',
    );
    return undefined;
  }
}
