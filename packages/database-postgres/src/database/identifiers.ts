import { PersistenceError } from './errors.js';
import type { PostgresDatabasePort } from './postgres.js';

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/u;

export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError('SQL identifier must be a lowercase identifier.');
  }

  return `"${identifier}"`;
}

export function qualifiedTable(database: PostgresDatabasePort, table: string): string {
  return `${quoteIdentifier(database.schema)}.${quoteIdentifier(table)}`;
}

const RECORD_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_RECORD_IDENTIFIER_LENGTH = 64;

export function validateRecordIdentifier(
  value: unknown,
  code: 'invalid_organization_id' | 'invalid_property_id' | 'invalid_availability_id',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RECORD_IDENTIFIER_LENGTH ||
    !RECORD_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PersistenceError(code, `${code} must be a valid identifier.`);
  }
}
