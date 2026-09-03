import type { QueryResultRow } from 'pg';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import type { PostgresDatabasePort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_IDENTIFIER_LENGTH = 64;
export const ORGANIZATION_NAME_MAX_LENGTH = 120;

export interface OrganizationInput {
  readonly id: string;
  readonly name: string;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface OrganizationRepository {
  create(input: OrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
}

interface OrganizationRow extends QueryResultRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  return [...value].length > maximum;
}

function validateOrganizationId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PersistenceError(
      'invalid_organization_id',
      'organization id must be a non-empty identifier of at most 64 characters.',
    );
  }
}

function validateOrganizationName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceError('invalid_organization_name', 'organization name must not be empty.');
  }

  const name = value.trim();
  if (name.length === 0 || exceedsCodePointLimit(name, ORGANIZATION_NAME_MAX_LENGTH)) {
    throw new PersistenceError(
      'invalid_organization_name',
      `organization name must contain 1 to ${ORGANIZATION_NAME_MAX_LENGTH} characters.`,
    );
  }

  return name;
}

function validateOrganizationInput(input: unknown): asserts input is OrganizationInput {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceError('invalid_organization_id', 'organization input must be an object.');
  }

  const record = input as Record<string, unknown>;
  validateOrganizationId(record['id']);
  validateOrganizationName(record['name']);
}

function mapOrganization(row: OrganizationRow): Organization {
  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  });
}

export class PostgresOrganizationRepository implements OrganizationRepository {
  private readonly organizationsTable: string;

  constructor(private readonly database: PostgresDatabasePort) {
    this.organizationsTable = qualifiedTable(database, 'organizations');
  }

  async create(input: OrganizationInput): Promise<Organization> {
    validateOrganizationInput(input);
    const name = validateOrganizationName(input.name);

    try {
      const result = await this.database.query<OrganizationRow>(
        `
          INSERT INTO ${this.organizationsTable} (id, name)
          VALUES ($1, $2)
          RETURNING id, name, created_at
        `,
        [input.id, name],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceError('database_corruption', 'organization insert returned no row.');
      }

      return mapOrganization(row);
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError('duplicate_organization', 'organization already exists.');
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Organization | null> {
    validateOrganizationId(id);

    const result = await this.database.query<OrganizationRow>(
      `SELECT id, name, created_at FROM ${this.organizationsTable} WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapOrganization(row);
  }
}

export function createPostgresOrganizationRepository(
  database: PostgresDatabasePort,
): OrganizationRepository {
  return new PostgresOrganizationRepository(database);
}
