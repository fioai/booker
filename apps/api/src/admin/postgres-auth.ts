import { createHash, randomBytes } from 'node:crypto';

import {
  createPostgresOwnerCredentialRepository,
  type PostgresDatabasePort,
} from '@booking-engine/database-postgres';

import {
  validateAdminSessionStoreOptions,
  validateAdminSessionUser,
  type AdminCredentialRecord,
  type AdminCredentialStore,
  type AdminSessionStoreOptions,
  type AdminSessionStore,
  type AdminSessionTicket,
  type AdminSessionUser,
  type AdminSession,
} from './auth.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

interface AdminSessionRow {
  readonly owner_id: unknown;
  readonly organization_id: unknown;
  readonly email: unknown;
  readonly role: unknown;
  readonly created_at: unknown;
  readonly last_seen_at: unknown;
  readonly expires_at: unknown;
}

export interface PostgresAdminCredentialStore extends AdminCredentialStore {
  create(input: AdminCredentialRecord): Promise<AdminCredentialRecord>;
  revokeMembership(organizationId: string, ownerId: string): Promise<boolean>;
}

export interface PostgresAdminSessionStore extends AdminSessionStore {
  create(user: AdminSessionUser): Promise<AdminSessionTicket>;
  get(token: string): Promise<AdminSession | null>;
  verifyCsrf(token: string, candidate: string): Promise<boolean>;
  destroy(token: string): Promise<void>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function timestamp(value: unknown, field: string): number {
  const parsed =
    value instanceof Date ? value.getTime() : Date.parse(typeof value === 'string' ? value : '');
  if (!Number.isFinite(parsed)) {
    throw new Error(field + ' is not a valid timestamp.');
  }
  return parsed;
}

function sessionFromRow(row: AdminSessionRow): AdminSession {
  const user = validateAdminSessionUser({
    id: row.owner_id as string,
    organizationId: row.organization_id as string,
    email: row.email as string,
    role: row.role as AdminSessionUser['role'],
  });
  return Object.freeze({
    ...user,
    createdAt: timestamp(row.created_at, 'created_at'),
    lastSeenAt: timestamp(row.last_seen_at, 'last_seen_at'),
    expiresAt: timestamp(row.expires_at, 'expires_at'),
  });
}

function qualifiedTable(database: PostgresDatabasePort, table: string): string {
  const schema = database.schema.replaceAll('"', '""');
  return '"' + schema + '"."' + table + '"';
}

export function createPostgresAdminCredentialStore(
  database: PostgresDatabasePort,
): PostgresAdminCredentialStore {
  return createPostgresOwnerCredentialRepository(
    database,
  ) as unknown as PostgresAdminCredentialStore;
}

export function createPostgresAdminSessionStore(
  database: PostgresDatabasePort,
  options: AdminSessionStoreOptions = {},
): PostgresAdminSessionStore {
  const { ttlMs, maxSessions, clock } = validateAdminSessionStoreOptions(options);
  const sessionsTable = qualifiedTable(database, 'admin_sessions');
  const identitiesTable = qualifiedTable(database, 'owner_identities');
  const membershipsTable = qualifiedTable(database, 'organization_memberships');

  return {
    async create(user: AdminSessionUser): Promise<AdminSessionTicket> {
      const validatedUser = validateAdminSessionUser(user);
      const now = clock();
      const expiresAt = now + ttlMs;
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
        throw new TypeError('session clock must return a finite timestamp.');
      }
      const sessionToken = newToken();
      const csrfToken = newToken();
      const sessionDigest = digest(sessionToken);
      const csrfDigest = digest(csrfToken);
      const createdAt = new Date(now);
      await database.withTransaction(async (transaction) => {
        const membership = await transaction.query(
          [
            'SELECT 1 FROM ' + identitiesTable + ' AS identity',
            'INNER JOIN ' + membershipsTable + ' AS membership',
            '  ON membership.identity_id = identity.id',
            'WHERE identity.id = $1 AND membership.organization_id = $2',
            "  AND identity.disabled_at IS NULL AND membership.status = 'active'",
          ].join('\n'),
          [validatedUser.id, validatedUser.organizationId],
        );
        if (membership.rowCount !== 1) {
          throw new Error('owner membership is no longer active.');
        }
        await transaction.query(
          ['DELETE FROM ' + sessionsTable, 'WHERE revoked_at IS NOT NULL OR expires_at <= $1'].join(
            '\n',
          ),
          [createdAt],
        );
        await transaction.query(
          [
            'DELETE FROM ' + sessionsTable,
            'WHERE session_digest IN (',
            '  SELECT session_digest FROM ' + sessionsTable,
            '  WHERE owner_id = $1 AND organization_id = $2 AND revoked_at IS NULL',
            '  ORDER BY last_seen_at DESC, created_at DESC OFFSET $3',
            ')',
          ].join('\n'),
          [validatedUser.id, validatedUser.organizationId, Math.max(0, maxSessions - 1)],
        );
        await transaction.query(
          [
            'INSERT INTO ' + sessionsTable + ' (',
            '  session_digest, owner_id, organization_id, email, role,',
            '  csrf_digest, created_at, last_seen_at, expires_at',
            ') VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)',
          ].join('\n'),
          [
            sessionDigest,
            validatedUser.id,
            validatedUser.organizationId,
            validatedUser.email,
            validatedUser.role,
            csrfDigest,
            createdAt,
            new Date(expiresAt),
          ],
        );
      });
      return Object.freeze({
        token: sessionToken,
        csrfToken,
        session: Object.freeze({
          ...validatedUser,
          csrfToken,
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
        }),
      });
    },

    async get(value: string): Promise<AdminSession | null> {
      if (!TOKEN_PATTERN.test(value)) {
        return null;
      }
      const now = clock();
      if (!Number.isFinite(now)) {
        return null;
      }
      return database.withTransaction(async (transaction) => {
        const result = await transaction.query<AdminSessionRow>(
          [
            'SELECT session.owner_id, session.organization_id, identity.email,',
            '       membership.role, session.created_at, session.last_seen_at, session.expires_at',
            'FROM ' + sessionsTable + ' AS session',
            'INNER JOIN ' + identitiesTable + ' AS identity',
            '  ON identity.id = session.owner_id AND identity.disabled_at IS NULL',
            'INNER JOIN ' + membershipsTable + ' AS membership',
            '  ON membership.identity_id = session.owner_id',
            ' AND membership.organization_id = session.organization_id',
            " AND membership.status = 'active'",
            'WHERE session.session_digest = $1',
            '  AND session.revoked_at IS NULL AND session.expires_at > $2',
            'LIMIT 1 FOR UPDATE',
          ].join('\n'),
          [digest(value), new Date(now)],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }
        const session = sessionFromRow(row);
        if (session.expiresAt <= now) {
          return null;
        }
        await transaction.query(
          'UPDATE ' + sessionsTable + ' SET last_seen_at = $2 WHERE session_digest = $1',
          [digest(value), new Date(now)],
        );
        return Object.freeze({ ...session, lastSeenAt: now });
      });
    },

    async verifyCsrf(value: string, candidate: string): Promise<boolean> {
      if (!TOKEN_PATTERN.test(value) || !TOKEN_PATTERN.test(candidate)) {
        return false;
      }
      try {
        const result = await database.query(
          [
            'SELECT 1 AS ok FROM ' + sessionsTable + ' AS session',
            'INNER JOIN ' + identitiesTable + ' AS identity',
            '  ON identity.id = session.owner_id AND identity.disabled_at IS NULL',
            'INNER JOIN ' + membershipsTable + ' AS membership',
            '  ON membership.identity_id = session.owner_id',
            ' AND membership.organization_id = session.organization_id',
            " AND membership.status = 'active'",
            'WHERE session.session_digest = $1 AND session.csrf_digest = $2',
            '  AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP',
            'LIMIT 1',
          ].join('\n'),
          [digest(value), digest(candidate)],
        );
        return result.rowCount === 1;
      } catch {
        return false;
      }
    },

    async destroy(value: string): Promise<void> {
      if (!TOKEN_PATTERN.test(value)) {
        return;
      }
      await database.withTransaction((transaction) =>
        transaction.query(
          [
            'UPDATE ' + sessionsTable,
            'SET revoked_at = CURRENT_TIMESTAMP',
            'WHERE session_digest = $1 AND revoked_at IS NULL',
          ].join('\n'),
          [digest(value)],
        ),
      );
    },
  };
}
