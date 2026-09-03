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
