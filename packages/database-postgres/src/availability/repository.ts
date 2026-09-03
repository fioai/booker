import type { QueryResultRow } from 'pg';

import { createLocalDateInterval, type LocalDateInterval } from '@booking-engine/booking-core';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort, PostgresTransactionPort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

export interface AvailabilityOrganizationScope {
  readonly organizationId: string;
}

export interface ManualBlockInput {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
  readonly reason: string;
}

export interface HoldInput {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
  readonly expiresAt: string | Date;
}

export interface ConfirmedOccupancyInput {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
}

export type AvailabilityRecordKind = 'manual' | 'hold' | 'occupancy';
export type AvailabilityRecordStatus = 'active' | 'held' | 'confirmed' | 'released';

export interface AvailabilityRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: AvailabilityRecordKind;
  readonly status: AvailabilityRecordStatus;
  readonly arrival: string;
  readonly departure: string;
  readonly expiresAt: string | null;
  readonly reason: string | null;
}

export interface AvailabilityRepository {
  createManualBlock(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord>;
  listManualBlocks(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
  ): Promise<readonly AvailabilityRecord[]>;
  releaseManualBlock(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean>;
  createHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord>;
  confirmHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<AvailabilityRecord | null>;
  releaseHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean>;
  createConfirmedOccupancy(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord>;
  releaseOccupancy(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean>;
  releaseExpiredHolds(scope: AvailabilityOrganizationScope, at: string | Date): Promise<number>;
  isAvailable(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<boolean>;
}

interface AvailabilityRow extends QueryResultRow {
  readonly record_id: unknown;
  readonly property_id: unknown;
  readonly block_kind: unknown;
  readonly status: unknown;
  readonly arrival: unknown;
  readonly departure: unknown;
  readonly expires_at: Date | string | null;
  readonly reason: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_IDENTIFIER_LENGTH = 64;
const MAX_REASON_LENGTH = 500;

function validateIdentifier(
  value: unknown,
  code: 'invalid_organization_id' | 'invalid_property_id' | 'invalid_availability_id',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PersistenceError(code, `${code} must be a valid identifier.`);
  }
}

function validateScope(scope: AvailabilityOrganizationScope): string {
  validateIdentifier(scope?.organizationId, 'invalid_organization_id');
  return scope.organizationId;
}

function validatePropertyId(propertyId: string): string {
  validateIdentifier(propertyId, 'invalid_property_id');
  return propertyId;
}

function validateRecordId(recordId: string): string {
  validateIdentifier(recordId, 'invalid_availability_id');
  return recordId;
}

function parseInterval(input: unknown): LocalDateInterval {
  const result = createLocalDateInterval(input);
  if (!result.ok) {
    throw new PersistenceError(
      'invalid_stay',
      'stay interval failed domain validation.',
      result.errors,
    );
  }
  return result.value;
}

function parseExpiry(value: unknown): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(typeof value === 'string' ? value : '');
  if (Number.isNaN(date.getTime())) {
    throw new PersistenceError('invalid_expiry', 'expiresAt must be a valid timestamp.');
  }
  return date;
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceError('invalid_availability_id', 'manual block reason must be a string.');
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        (codePoint >= 0x0000 && codePoint <= 0x001f) ||
        (codePoint >= 0x007f && codePoint <= 0x009f) ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
  ) {
    throw new PersistenceError(
      'invalid_availability_id',
      'manual block reason must not contain control characters.',
    );
  }
  const reason = value.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new PersistenceError(
      'invalid_availability_id',
      'manual block reason has an invalid length.',
    );
  }
  return reason;
}

function parseInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersistenceError('invalid_stay', 'availability input must be an object.');
  }
  return value as Record<string, unknown>;
}

function parseManualBlock(
  input: unknown,
): ManualBlockInput & { readonly interval: LocalDateInterval } {
  const record = parseInputRecord(input);
  const id = record['id'];
  validateRecordId(id as string);
  const interval = parseInterval({ arrival: record['arrival'], departure: record['departure'] });
  return Object.freeze({
    id: id as string,
    arrival: interval.arrival,
    departure: interval.departure,
    reason: parseReason(record['reason']),
    interval,
  });
}

function parseHold(
  input: unknown,
): HoldInput & { readonly interval: LocalDateInterval; readonly expires: Date } {
  const record = parseInputRecord(input);
  const id = record['id'];
  validateRecordId(id as string);
  const interval = parseInterval({ arrival: record['arrival'], departure: record['departure'] });
  const expires = parseExpiry(record['expiresAt']);
  return Object.freeze({
    id: id as string,
    arrival: interval.arrival,
    departure: interval.departure,
    expiresAt: record['expiresAt'] as string | Date,
    interval,
    expires,
  });
}

function parseConfirmedOccupancy(
  input: unknown,
): ConfirmedOccupancyInput & { readonly interval: LocalDateInterval } {
  const record = parseInputRecord(input);
  const id = record['id'];
  validateRecordId(id as string);
  const interval = parseInterval({ arrival: record['arrival'], departure: record['departure'] });
  return Object.freeze({
    id: id as string,
    arrival: interval.arrival,
    departure: interval.departure,
    interval,
  });
}

function requirePropertyQuery(
  transaction: PostgresTransactionPort,
  propertiesTable: string,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  return transaction
    .query<{
      id: string;
    }>(`SELECT id FROM ${propertiesTable} WHERE organization_id = $1 AND id = $2`, [
      organizationId,
      propertyId,
    ])
    .then((result) => {
      if (result.rowCount === 0) {
        throw new PersistenceError(
          'property_not_found',
          'property does not exist in this organization.',
        );
      }
    });
}

async function requireNoICalConflict(
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

function mapRecord(row: AvailabilityRow): AvailabilityRecord {
  if (
    typeof row.record_id !== 'string' ||
    typeof row.property_id !== 'string' ||
    (row.block_kind !== 'manual' && row.block_kind !== 'hold' && row.block_kind !== 'occupancy') ||
    (row.status !== 'active' && row.status !== 'released') ||
    typeof row.arrival !== 'string' ||
    typeof row.departure !== 'string' ||
    (row.reason !== null && typeof row.reason !== 'string')
  ) {
    throw new PersistenceError('database_corruption', 'availability row has an invalid shape.');
  }
  const expiresAt = row.expires_at === null ? null : new Date(row.expires_at).toISOString();
  const status: AvailabilityRecordStatus =
    row.status === 'released'
      ? 'released'
      : row.block_kind === 'hold'
        ? 'held'
        : row.block_kind === 'occupancy'
          ? 'confirmed'
          : 'active';
  return Object.freeze({
    id: row.record_id,
    propertyId: row.property_id,
    kind: row.block_kind,
    status,
    arrival: row.arrival,
    departure: row.departure,
    expiresAt,
    reason: row.reason,
  });
}

async function withDeadlockRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isPostgresError(error) || error.code !== '40P01' || attempt >= 2) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

export class PostgresAvailabilityRepository implements AvailabilityRepository {
  private readonly blocksTable: string;
  private readonly icalBlocksTable: string;
  private readonly propertiesTable: string;

  constructor(private readonly database: PostgresDatabasePort) {
    this.blocksTable = qualifiedTable(database, 'availability_blocks');
    this.icalBlocksTable = qualifiedTable(database, 'ical_blocks');
    this.propertiesTable = qualifiedTable(database, 'properties');
  }

  private async insertRecord(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    id: string,
    kind: AvailabilityRecordKind,
    interval: LocalDateInterval,
    expiresAt: Date | null,
    reason: string | null,
  ): Promise<AvailabilityRecord> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    validateRecordId(id);
    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requirePropertyQuery(transaction, this.propertiesTable, organizationId, property);
        await requireNoICalConflict(
          transaction,
          this.icalBlocksTable,
          organizationId,
          property,
          interval.arrival,
          interval.departure,
        );
        const result = await transaction.query<AvailabilityRow>(
          `
            INSERT INTO ${this.blocksTable} (
              organization_id,
              property_id,
              record_id,
              block_kind,
              status,
              stay,
              expires_at,
              reason
            )
            VALUES ($1, $2, $3, $4, 'active', daterange($5::date, $6::date, '[)'), $7, $8)
            RETURNING record_id, property_id, block_kind, status,
                      lower(stay)::text AS arrival, upper(stay)::text AS departure,
                      expires_at, reason
          `,
          [
            organizationId,
            property,
            id,
            kind,
            interval.arrival,
            interval.departure,
            expiresAt,
            reason,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new PersistenceError('database_corruption', 'availability insert returned no row.');
        }
        return mapRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23P01') {
        throw new PersistenceError(
          'availability_conflict',
          'stay overlaps an active availability record.',
        );
      }
      if (isPostgresError(error) && error.code === '40P01') {
        throw new PersistenceError(
          'availability_conflict',
          'stay overlaps a concurrently inserted record.',
        );
      }
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError(
          'duplicate_availability_record',
          'availability record already exists.',
        );
      }
      throw error;
    }
  }

  async createManualBlock(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord> {
    const block = parseManualBlock(input);
    return this.insertRecord(
      scope,
      propertyId,
      block.id,
      'manual',
      block.interval,
      null,
      block.reason,
    );
  }

  async listManualBlocks(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
  ): Promise<readonly AvailabilityRecord[]> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    await this.database.withTransaction((transaction) =>
      requirePropertyQuery(transaction, this.propertiesTable, organizationId, property),
    );
    const result = await this.database.query<AvailabilityRow>(
      `
        SELECT record_id, property_id, block_kind, status,
               lower(stay)::text AS arrival, upper(stay)::text AS departure,
               expires_at, reason
        FROM ${this.blocksTable}
        WHERE organization_id = $1 AND property_id = $2 AND block_kind = 'manual'
        ORDER BY lower(stay), record_id
      `,
      [organizationId, property],
    );
    return Object.freeze(result.rows.map(mapRecord));
  }

  async releaseManualBlock(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean> {
    return this.releaseRecord(scope, propertyId, recordId, 'manual');
  }

  async createHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord> {
    const hold = parseHold(input);
    return this.insertRecord(scope, propertyId, hold.id, 'hold', hold.interval, hold.expires, null);
  }

  async confirmHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<AvailabilityRecord | null> {
    return this.transitionRecord(scope, propertyId, recordId, 'hold', 'occupancy', null);
  }

  releaseHold(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean> {
    return this.releaseRecord(scope, propertyId, recordId, 'hold');
  }

  async createConfirmedOccupancy(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<AvailabilityRecord> {
    const occupancy = parseConfirmedOccupancy(input);
    return this.insertRecord(
      scope,
      propertyId,
      occupancy.id,
      'occupancy',
      occupancy.interval,
      null,
      null,
    );
  }

  releaseOccupancy(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
  ): Promise<boolean> {
    return this.releaseRecord(scope, propertyId, recordId, 'occupancy');
  }

  async releaseExpiredHolds(
    scope: AvailabilityOrganizationScope,
    at: string | Date,
  ): Promise<number> {
    const organizationId = validateScope(scope);
    const timestamp = parseExpiry(at);
    return withDeadlockRetry(() =>
      this.database.withTransaction(async (transaction) => {
        const properties = await transaction.query<{ property_id: string }>(
          `
            SELECT DISTINCT property_id
            FROM ${this.blocksTable}
            WHERE organization_id = $1
              AND block_kind = 'hold'
              AND status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at <= $2
            ORDER BY property_id
          `,
          [organizationId, timestamp],
        );
        let released = 0;
        for (const row of properties.rows) {
          await lockProperty(transaction, organizationId, row.property_id);
          const result = await transaction.query(
            `
              UPDATE ${this.blocksTable}
              SET status = 'released', released_at = $2
              WHERE organization_id = $1
                AND property_id = $3
                AND block_kind = 'hold'
                AND status = 'active'
                AND expires_at IS NOT NULL
                AND expires_at <= $2
            `,
            [organizationId, timestamp, row.property_id],
          );
          released += result.rowCount ?? 0;
        }
        return released;
      }),
    );
  }

  async isAvailable(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<boolean> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const interval = parseInterval(input);
    await this.database.withTransaction((transaction) =>
      requirePropertyQuery(transaction, this.propertiesTable, organizationId, property),
    );
    const result = await this.database.query(
      `
        SELECT 1
        FROM ${this.blocksTable}
        WHERE organization_id = $1
          AND property_id = $2
          AND status = 'active'
          AND stay && daterange($3::date, $4::date, '[)')
        UNION ALL
        SELECT 1
        FROM ${this.icalBlocksTable}
        WHERE organization_id = $1
          AND property_id = $2
          AND status = 'active'
          AND daterange(arrival, departure, '[)') && daterange($3::date, $4::date, '[)')
        LIMIT 1
      `,
      [organizationId, property, interval.arrival, interval.departure],
    );
    return result.rowCount === 0;
  }

  private async releaseRecord(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
    kind: AvailabilityRecordKind,
  ): Promise<boolean> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRecordId(recordId);
    return withDeadlockRetry(() =>
      this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requirePropertyQuery(transaction, this.propertiesTable, organizationId, property);
        const result = await transaction.query(
          `
            UPDATE ${this.blocksTable}
            SET status = 'released', released_at = CURRENT_TIMESTAMP
            WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
              AND block_kind = $4 AND status = 'active'
          `,
          [organizationId, property, id, kind],
        );
        return result.rowCount === 1;
      }),
    );
  }

  private async transitionRecord(
    scope: AvailabilityOrganizationScope,
    propertyId: string,
    recordId: string,
    fromKind: AvailabilityRecordKind,
    toKind: AvailabilityRecordKind,
    expiresAt: Date | null,
  ): Promise<AvailabilityRecord | null> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRecordId(recordId);
    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requirePropertyQuery(transaction, this.propertiesTable, organizationId, property);
        const existing = await transaction.query<{
          arrival: string;
          departure: string;
        }>(
          `
            SELECT lower(stay)::text AS arrival, upper(stay)::text AS departure
            FROM ${this.blocksTable}
            WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
              AND block_kind = $4 AND status = 'active'
          `,
          [organizationId, property, id, fromKind],
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) {
          return null;
        }
        await requireNoICalConflict(
          transaction,
          this.icalBlocksTable,
          organizationId,
          property,
          existingRow.arrival,
          existingRow.departure,
        );
        const result = await transaction.query<AvailabilityRow>(
          `
            UPDATE ${this.blocksTable}
            SET block_kind = $5, expires_at = $6
            WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
              AND block_kind = $4 AND status = 'active'
            RETURNING record_id, property_id, block_kind, status,
                      lower(stay)::text AS arrival, upper(stay)::text AS departure,
                      expires_at, reason
          `,
          [organizationId, property, id, fromKind, toKind, expiresAt],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapRecord(row);
      });
    } catch (error) {
      if (isPostgresError(error) && error.code === '23P01') {
        throw new PersistenceError(
          'availability_conflict',
          'stay overlaps an active availability record.',
        );
      }
      throw error;
    }
  }
}

export function createPostgresAvailabilityRepository(
  database: PostgresDatabasePort,
): AvailabilityRepository {
  return new PostgresAvailabilityRepository(database);
}
