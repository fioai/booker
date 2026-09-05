import { PersistenceError } from './errors.js';
import type { PostgresTransactionPort } from './postgres.js';

export async function requireProperty(
  transaction: PostgresTransactionPort,
  propertiesTable: string,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  const result = await transaction.query(
    `SELECT id FROM ${propertiesTable} WHERE organization_id = $1 AND id = $2`,
    [organizationId, propertyId],
  );
  if (result.rowCount === 0) {
    throw new PersistenceError(
      'property_not_found',
      'property does not exist in this organization.',
    );
  }
}

export async function requireNoICalConflict(
  transaction: PostgresTransactionPort,
  icalBlocksTable: string,
  organizationId: string,
  propertyId: string,
  arrival: string,
  departure: string,
): Promise<void> {
  const result = await transaction.query(
    `
      SELECT 1
      FROM ${icalBlocksTable}
      WHERE organization_id = $1
        AND property_id = $2
        AND status = 'active'
        AND daterange(arrival, departure, '[)') && daterange($3::date, $4::date, '[)')
      LIMIT 1
    `,
    [organizationId, propertyId, arrival, departure],
  );
  if (result.rowCount !== 0) {
    throw new PersistenceError('availability_conflict', 'stay overlaps an active iCalendar block.');
  }
}
