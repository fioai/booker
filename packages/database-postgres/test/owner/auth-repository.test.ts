import { describe, expect, it, vi } from 'vitest';

import {
  createPostgresOwnerCredentialRepository,
  type PostgresDatabasePort,
} from '../../src/index.js';

function fakeDatabase(): PostgresDatabasePort {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const transaction = { query };
  return {
    dialect: 'postgres',
    schema: 'test',
    query,
    withTransaction: vi.fn(async (work) => work(transaction)),
    close: vi.fn(async () => undefined),
  } as unknown as PostgresDatabasePort;
}

describe('PostgreSQL owner identity and membership repository', () => {
  it('returns only an active organization membership with a password verifier', async () => {
    const database = fakeDatabase();
    (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          id: 'owner-a',
          email: 'owner@example.test',
          password_hash:
            'scrypt$16384$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw',
          organization_id: 'org-a',
          role: 'owner',
        },
      ],
      rowCount: 1,
    });
    const repository = createPostgresOwnerCredentialRepository(database);

    await expect(repository.findByEmail(' Owner@Example.test ')).resolves.toEqual({
      id: 'owner-a',
      email: 'owner@example.test',
      passwordHash:
        'scrypt$16384$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw',
      organizationId: 'org-a',
      role: 'owner',
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('organization_memberships'),
      ['owner@example.test'],
    );
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('i.disabled_at IS NULL'), [
      'owner@example.test',
    ]);
  });

  it('creates the identity and membership in one transaction', async () => {
    const database = fakeDatabase();
    const query = database.query as ReturnType<typeof vi.fn>;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'owner-a',
            email: 'owner@example.test',
            organization_id: 'org-a',
            role: 'owner',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const repository = createPostgresOwnerCredentialRepository(database);

    await expect(
      repository.create({
        id: 'owner-a',
        email: 'owner@example.test',
        passwordHash:
          'scrypt$16384$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw',
        organizationId: 'org-a',
        role: 'owner',
      }),
    ).resolves.toMatchObject({ id: 'owner-a', organizationId: 'org-a', role: 'owner' });
    expect(database.withTransaction).toHaveBeenCalledOnce();
  });

  it('rejects plaintext or unsupported credential material before opening a transaction', async () => {
    const database = fakeDatabase();
    const repository = createPostgresOwnerCredentialRepository(database);

    await expect(
      repository.create({
        id: 'owner-a',
        email: 'owner@example.test',
        passwordHash: 'plaintext-password-that-must-not-be-stored',
        organizationId: 'org-a',
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'invalid_password_hash' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects scrypt parameters outside the documented application profile', async () => {
    const database = fakeDatabase();
    const repository = createPostgresOwnerCredentialRepository(database);

    await expect(
      repository.create({
        id: 'owner-a',
        email: 'owner@example.test',
        passwordHash:
          'scrypt$32768$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw',
        organizationId: 'org-a',
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'invalid_password_hash' });
  });
});
