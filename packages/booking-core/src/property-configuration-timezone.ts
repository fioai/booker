import type { PropertyValidationErrorV1 } from './property-configuration-types.js';
import { addValidationErrorV1, readTextV1 } from './property-configuration-validation.js';

function isIanaTimezoneShapeV1(value: string): boolean {
  return /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/u.test(value);
}

export function readTimezoneV1(
  value: unknown,
  maximum: number,
  errors: PropertyValidationErrorV1[],
): string | undefined {
  const timezone = readTextV1(value, 'timezone', maximum, errors);
  if (timezone === undefined) {
    return undefined;
  }

  if (!isIanaTimezoneShapeV1(timezone)) {
    addValidationErrorV1(
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
    addValidationErrorV1(
      errors,
      'timezone',
      'unsupported_timezone',
      'timezone is not supported by the runtime.',
    );
    return undefined;
  }
}
