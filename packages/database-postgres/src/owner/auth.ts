import type { QueryResultRow } from 'pg';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import type { PostgresDatabasePort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

export type OwnerRole = 'owner' | 'admin' | 'manager' | 'viewer';

export interface OwnerCredentialRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: OwnerRole;
  readonly passwordHash: string;
}

export interface OwnerCredentialRepository {
  findByEmail(email: string): Promise<OwnerCredentialRecord | null>;
  create(input: OwnerCredentialRecord): Promise<OwnerCredentialRecord>;
  revokeMembership(organizationId: string, ownerId: string): Promise<boolean>;
}

interface OwnerCredentialRow extends QueryResultRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly password_hash: unknown;
  readonly organization_id: unknown;
  readonly role: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PASSWORD_HASH_PATTERN = /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u;

function identifier(value: unknown, field: 'owner' | 'organization'): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new PersistenceError(
      field === 'owner' ? 'invalid_owner_id' : 'invalid_organization_id',
      `${field} id must be a bounded identifier.`,
    );
  }
  return value;
}

function email(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceError('invalid_owner_email', 'owner email must be a string.');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new PersistenceError('invalid_owner_email', 'owner email must be a valid address.');
  }
  return normalized;
}

function role(value: unknown): OwnerRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'manager' && value !== 'viewer') {
    throw new PersistenceError('invalid_owner_role', 'owner membership role is invalid.');
  }
  return value;
}

function passwordHash(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacters(value) ||
    !PASSWORD_HASH_PATTERN.test(value)
  ) {
    throw new PersistenceError(
      'invalid_password_hash',
      'owner credential must contain a supported password verifier.',
    );
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function mapRow(row: OwnerCredentialRow): OwnerCredentialRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.organization_id !== 'string' ||
    typeof row.email !== 'string' ||
    typeof row.password_hash !== 'string'
  ) {
    throw new PersistenceError('database_corruption', 'owner credential row has an invalid shape.');
  }
  return Object.freeze({
    id: identifier(row.id, 'owner'),
    organizationId: identifier(row.organization_id, 'organization'),
    email: email(row.email),
    role: role(row.role),
    passwordHash: passwordHash(row.password_hash),
  });
}

function validateInput(input: OwnerCredentialRecord): OwnerCredentialRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceError(
      'owner_auth_validation',
      'owner credential input must be an object.',
    );
  }
  return Object.freeze({
    id: identifier(input.id, 'owner'),
    organizationId: identifier(input.organizationId, 'organization'),
    email: email(input.email),
    role: role(input.role),
    passwordHash: passwordHash(input.passwordHash),
  });
}

export class PostgresOwnerCredentialRepository implements OwnerCredentialRepository {
  private readonly identitiesTable: string;
  private readonly membershipsTable: string;

  constructor(private readonly database: PostgresDatabasePort) {
    this.identitiesTable = qualifiedTable(database, 'owner_identities');
    this.membershipsTable = qualifiedTable(database, 'organization_memberships');
  }

  async findByEmail(value: string): Promise<OwnerCredentialRecord | null> {
    const normalized = email(value);
    const result = await this.database.query<OwnerCredentialRow>(
      `
        SELECT i.id, i.email, i.password_hash, m.organization_id, m.role
        FROM ${this.identitiesTable} AS i
        INNER JOIN ${this.membershipsTable} AS m ON m.identity_id = i.id
        WHERE lower(i.email) = $1
          AND i.disabled_at IS NULL
          AND m.status = 'active'
        ORDER BY m.organization_id
        LIMIT 2
      `,
      [normalized],
    );
    // A login without an explicit tenant selector must never choose one tenant
    // arbitrarily when an identity has multiple active memberships.
    if (result.rows.length !== 1) {
      return null;
    }
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async create(input: OwnerCredentialRecord): Promise<OwnerCredentialRecord> {
    const credential = validateInput(input);
    try {
      await this.database.withTransaction(async (transaction) => {
        await transaction.query(
          `
            INSERT INTO ${this.identitiesTable} (id, email, password_hash)
            VALUES ($1, $2, $3)
          `,
          [credential.id, credential.email, credential.passwordHash],
        );
        await transaction.query(
          `
            INSERT INTO ${this.membershipsTable} (identity_id, organization_id, role, status)
            VALUES ($1, $2, $3, 'active')
          `,
          [credential.id, credential.organizationId, credential.role],
        );
      });
      return credential;
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError('duplicate_owner_identity', 'owner identity already exists.');
      }
      throw error;
    }
  }

  async revokeMembership(organizationId: string, ownerId: string): Promise<boolean> {
    const organization = identifier(organizationId, 'organization');
    const owner = identifier(ownerId, 'owner');
    const result = await this.database.query(
      `
        UPDATE ${this.membershipsTable}
        SET status = 'inactive'
        WHERE organization_id = $1 AND identity_id = $2 AND status = 'active'
      `,
      [organization, owner],
    );
    return result.rowCount === 1;
  }
}

export function createPostgresOwnerCredentialRepository(
  database: PostgresDatabasePort,
): OwnerCredentialRepository {
  return new PostgresOwnerCredentialRepository(database);
}
