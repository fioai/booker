import { describe, expect, it, vi } from 'vitest';

import {
  createPostgresAdminCredentialStore,
  createPostgresAdminSessionStore,
} from '../../src/index.js';
import type { PostgresDatabasePort } from '@booking-engine/database-postgres';

const user = {
  id: 'owner-a',
  organizationId: 'org-a',
  email: 'owner@example.test',
  role: 'owner' as const,
};

function makeDatabase(): {
  readonly database: PostgresDatabasePort;
  readonly query: ReturnType<typeof vi.fn>;
  readonly transactionQuery: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const transactionQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const database = {
    dialect: 'postgres' as const,
    schema: 'test',
    query,
    withTransaction: vi.fn(
      async (work: (transaction: { query: typeof transactionQuery }) => unknown) =>
        work({ query: transactionQuery }),
    ),
    close: vi.fn(async () => undefined),
  } as unknown as PostgresDatabasePort;
  return { database, query, transactionQuery };
}

describe('PostgreSQL-backed admin credentials and sessions', () => {
  it('uses the persisted credential repository and stores only a digest of each opaque token', async () => {
    const { database, transactionQuery } = makeDatabase();
    const credentials = createPostgresAdminCredentialStore(database);
    const hash =
      'scrypt$16384$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw';
    const repository = credentials as unknown as {
      create(input: typeof user & { readonly passwordHash: string }): Promise<unknown>;
    };
    await expect(repository.create({ ...user, passwordHash: hash })).resolves.toMatchObject({
      organizationId: user.organizationId,
    });
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('owner_identities'),
      expect.arrayContaining([hash]),
    );
  });

  it('persists, reloads, verifies, expires, and revokes server-side sessions', async () => {
    const { database, query, transactionQuery } = makeDatabase();
    const store = createPostgresAdminSessionStore(database, {
      clock: () => 1_000,
      ttlMs: 10_000,
      maxSessions: 2,
    });

    const ticket = await store.create(user);
    expect(ticket.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ticket.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const insertCall = transactionQuery.mock.calls.find(([text]) =>
      String(text).includes('INSERT INTO'),
    );
    expect(JSON.stringify(insertCall)).not.toContain(ticket.token);
    expect(JSON.stringify(insertCall)).not.toContain(ticket.csrfToken);

    transactionQuery.mockResolvedValueOnce({
      rows: [
        {
          owner_id: user.id,
          organization_id: user.organizationId,
          email: user.email,
          role: 'manager',
          created_at: new Date(1_000),
          last_seen_at: new Date(1_000),
          expires_at: new Date(11_000),
        },
      ],
      rowCount: 1,
    });
    await expect(store.get(ticket.token)).resolves.toMatchObject({
      id: user.id,
      organizationId: user.organizationId,
      role: 'manager',
      expiresAt: 11_000,
    });
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('identity.disabled_at IS NULL'),
      expect.anything(),
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('membership.status ='),
      expect.anything(),
    );
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('membership.role'),
      expect.anything(),
    );

    query.mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 });
    if (store.verifyCsrf === undefined) {
      throw new Error('persistent sessions must expose CSRF verification.');
    }
    await expect(store.verifyCsrf(ticket.token, ticket.csrfToken)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('identity.disabled_at IS NULL'),
      expect.anything(),
    );

    await store.destroy(ticket.token);
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('revoked_at'),
      expect.anything(),
    );
  });
});
