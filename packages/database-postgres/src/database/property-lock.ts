import type { PostgresTransactionPort } from './postgres.js';

/**
 * Serializes every availability-affecting write for one tenant/property pair.
 * Both the availability and iCalendar repositories must use this exact key.
 */
export async function lockProperty(
  transaction: PostgresTransactionPort,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `booking-engine:property:${organizationId}:${propertyId}`,
  ]);
}
