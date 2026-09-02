import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { createPostgresPropertyRepository } from '../src/index.js';
import type { PostgresDatabasePort } from '../src/database/postgres.js';

const validPublicRow = {
  id: 'property-1',
  name: 'A Bungalow',
  summary: 'A summary.',
  country: 'CA',
  timezone: 'America/Toronto',
  currency: 'EUR',
  property_type: 'bungalow',
  bedroom_count: 1,
  bed_configuration: [{ type: 'queen', quantity: 1 }],
  bathroom_count: 1,
  maximum_guests: 1,
  amenities: ['garden'],
  host_notes: 'A host note.',
};

function databaseForPublicRow(row: unknown): PostgresDatabasePort {
  return {
    dialect: 'postgres',
    schema: 'public',
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
    ): Promise<QueryResult<Row>> {
      if (!text.includes('public_properties')) {
        throw new Error(`Unexpected query: ${text}`);
      }

      return {
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [row] as Row[],
      };
    },
    async withTransaction<T>(): Promise<T> {
      throw new Error('Transactions are not used by this test.');
    },
    async close(): Promise<void> {},
  };
}

describe('PostgresPropertyRepository public projection validation', () => {
  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-finite', Number.NaN],
    ['too large', 201],
  ])('rejects a corrupted %s public count', async (_label, maximumGuests) => {
    const repository = createPostgresPropertyRepository(
      databaseForPublicRow({ ...validPublicRow, maximum_guests: maximumGuests }),
    );

    await expect(
      repository.findPublicById({ organizationId: 'organization-1' }, 'property-1'),
    ).rejects.toMatchObject({ code: 'database_corruption' });
  });

  it('rejects a corrupted public bed quantity instead of returning it', async () => {
    const repository = createPostgresPropertyRepository(
      databaseForPublicRow({
        ...validPublicRow,
        bed_configuration: [{ type: 'queen', quantity: 0 }],
      }),
    );

    await expect(
      repository.findPublicById({ organizationId: 'organization-1' }, 'property-1'),
    ).rejects.toMatchObject({ code: 'database_corruption' });
  });
});
