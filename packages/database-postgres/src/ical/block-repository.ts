import type { QueryResultRow } from 'pg';

import { createLocalDateInterval } from '@booking-engine/booking-core';
import { ICAL_SEQUENCE_MAX, ICalStaleWriteError } from '@booking-engine/channel-ical';
import type {
  ICalBlockRecord,
  ICalBlockStore,
  ICalReleaseProvenance,
  ICalScope,
  ICalEventStatus,
} from '@booking-engine/channel-ical';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort, PostgresTransactionPort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

interface ICalBlockRow extends QueryResultRow {
  readonly organization_id: unknown;
  readonly property_id: unknown;
  readonly source_id: unknown;
  readonly external_uid: unknown;
  readonly arrival: unknown;
  readonly departure: unknown;
  readonly status: unknown;
  readonly event_status: unknown;
  readonly sequence: unknown;
  readonly last_modified: unknown;
  readonly summary: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_UID_LENGTH = 512;

function hasUnsafeText(value: string, allowLineFeed: boolean): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return (code <= 31 && !(allowLineFeed && code === 10)) || (code >= 127 && code <= 159);
  });
}

function validateIdentifier(
  value: unknown,
  code: 'invalid_organization_id' | 'invalid_property_id' | 'invalid_availability_id',
): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new PersistenceError(code, `${code} must be a valid identifier.`);
  }
}

function validateScope(scope: ICalScope): {
  readonly organizationId: string;
  readonly propertyId: string;
} {
  validateIdentifier(scope?.organizationId, 'invalid_organization_id');
  validateIdentifier(scope?.propertyId, 'invalid_property_id');
  return { organizationId: scope.organizationId, propertyId: scope.propertyId };
}

function validateSourceId(sourceId: string): string {
  validateIdentifier(sourceId, 'invalid_availability_id');
  return sourceId;
}

function validateUid(uid: string): string {
  if (
    typeof uid !== 'string' ||
    uid.trim().length === 0 ||
    uid !== uid.trim() ||
    uid.length > MAX_UID_LENGTH ||
    hasUnsafeText(uid, false)
  ) {
    throw new PersistenceError('invalid_availability_id', 'iCalendar event UID is invalid.');
  }
  return uid;
}

function mapSequence(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  const sequence =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > ICAL_SEQUENCE_MAX) {
    throw new PersistenceError('database_corruption', 'iCalendar block sequence is invalid.');
  }
  return sequence;
}

function validateRecord(
  scope: ICalScope,
  sourceId: string,
  record: ICalBlockRecord,
): ICalBlockRecord {
  const validatedScope = validateScope(scope);
  const source = validateSourceId(sourceId);
  const uid = validateUid(record.uid);
  if (
    record.organizationId !== validatedScope.organizationId ||
    record.propertyId !== validatedScope.propertyId ||
    record.sourceId !== source ||
    record.status !== 'active'
  ) {
    throw new PersistenceError(
      'invalid_availability_id',
      'iCalendar block does not match the requested tenant scope.',
    );
  }
  const interval = createLocalDateInterval({
    arrival: record.arrival,
    departure: record.departure,
  });
  if (!interval.ok) {
    throw new PersistenceError(
      'invalid_stay',
      'iCalendar block interval is invalid.',
      interval.errors,
    );
  }
  if (
    (record.eventStatus !== 'confirmed' &&
      record.eventStatus !== 'tentative' &&
      record.eventStatus !== 'cancelled' &&
      record.eventStatus !== 'unknown') ||
    (record.sequence !== null &&
      (!Number.isInteger(record.sequence) ||
        record.sequence < 0 ||
        record.sequence > ICAL_SEQUENCE_MAX)) ||
    (record.lastModified !== null && Number.isNaN(Date.parse(record.lastModified))) ||
    (record.summary !== null &&
      (typeof record.summary !== 'string' ||
        record.summary.length > 2_000 ||
        hasUnsafeText(record.summary, true)))
  ) {
    throw new PersistenceError('invalid_availability_id', 'iCalendar block metadata is invalid.');
  }
  return Object.freeze({
    ...record,
    organizationId: validatedScope.organizationId,
    propertyId: validatedScope.propertyId,
    sourceId: source,
    uid,
    arrival: interval.value.arrival,
    departure: interval.value.departure,
  });
}

function mapRow(row: ICalBlockRow): ICalBlockRecord {
  if (
    typeof row.organization_id !== 'string' ||
    typeof row.property_id !== 'string' ||
    typeof row.source_id !== 'string' ||
    typeof row.external_uid !== 'string' ||
    typeof row.arrival !== 'string' ||
    typeof row.departure !== 'string' ||
    (row.status !== 'active' && row.status !== 'released') ||
    (row.event_status !== 'confirmed' &&
      row.event_status !== 'tentative' &&
      row.event_status !== 'cancelled' &&
      row.event_status !== 'unknown') ||
    (row.last_modified !== null &&
      !(row.last_modified instanceof Date) &&
      typeof row.last_modified !== 'string') ||
    (row.summary !== null && typeof row.summary !== 'string')
  ) {
    throw new PersistenceError('database_corruption', 'iCalendar block row has an invalid shape.');
  }
  try {
    validateUid(row.external_uid);
  } catch {
    throw new PersistenceError('database_corruption', 'iCalendar block UID is invalid.');
  }
  const interval = createLocalDateInterval({
    arrival: row.arrival,
    departure: row.departure,
  });
  if (!interval.ok) {
    throw new PersistenceError('database_corruption', 'iCalendar block row has an invalid stay.');
  }
  const sequence = mapSequence(row.sequence);
  if (row.summary !== null && (row.summary.length > 2_000 || hasUnsafeText(row.summary, true))) {
    throw new PersistenceError('database_corruption', 'iCalendar block row has invalid metadata.');
  }
  let lastModified: string | null;
  try {
    lastModified = row.last_modified === null ? null : new Date(row.last_modified).toISOString();
  } catch {
    throw new PersistenceError('database_corruption', 'iCalendar block timestamp is invalid.');
  }
  if (lastModified !== null && Number.isNaN(Date.parse(lastModified))) {
    throw new PersistenceError('database_corruption', 'iCalendar block timestamp is invalid.');
  }
  return Object.freeze({
    organizationId: row.organization_id,
    propertyId: row.property_id,
    sourceId: row.source_id,
    uid: row.external_uid,
    arrival: interval.value.arrival,
    departure: interval.value.departure,
    status: row.status,
    eventStatus: row.event_status as ICalEventStatus,
    sequence,
    lastModified,
    summary: row.summary as string | null,
  });
}

function requireProperty(
  transaction: PostgresTransactionPort,
  propertiesTable: string,
  scope: { readonly organizationId: string; readonly propertyId: string },
): Promise<void> {
  return transaction
    .query<{
      id: string;
    }>(`SELECT id FROM ${propertiesTable} WHERE organization_id = $1 AND id = $2`, [
      scope.organizationId,
      scope.propertyId,
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

async function requireNoAvailabilityConflict(
  transaction: PostgresTransactionPort,
  availabilityTable: string,
  organizationId: string,
  propertyId: string,
  arrival: string,
  departure: string,
): Promise<void> {
  const result = await transaction.query(
    `
      SELECT 1
      FROM ${availabilityTable}
      WHERE organization_id = $1
        AND property_id = $2
        AND status = 'active'
        AND stay && daterange($3::date, $4::date, '[)')
      LIMIT 1
    `,
    [organizationId, propertyId, arrival, departure],
  );
  if (result.rowCount !== 0) {
    throw new PersistenceError(
      'availability_conflict',
      'iCalendar block overlaps an active availability record.',
    );
  }
}

export class PostgresICalBlockStore implements ICalBlockStore {
  private readonly blocksTable: string;
  private readonly availabilityTable: string;
  private readonly propertiesTable: string;
  private readonly transaction: PostgresTransactionPort | undefined;

  constructor(
    private readonly database: PostgresDatabasePort,
    transaction?: PostgresTransactionPort,
  ) {
    this.blocksTable = qualifiedTable(database, 'ical_blocks');
    this.availabilityTable = qualifiedTable(database, 'availability_blocks');
    this.propertiesTable = qualifiedTable(database, 'properties');
    this.transaction = transaction;
  }

  private query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ) {
    return this.transaction === undefined
      ? this.database.query<Row>(text, values)
      : this.transaction.query<Row>(text, values);
  }

  async list(scope: ICalScope, sourceId: string): Promise<readonly ICalBlockRecord[]> {
    const validatedScope = validateScope(scope);
    const source = validateSourceId(sourceId);
    const result = await this.query<ICalBlockRow>(
      `
        SELECT organization_id, property_id, source_id, external_uid,
               arrival::text, departure::text, status, event_status,
               sequence, last_modified, summary
        FROM ${this.blocksTable}
        WHERE organization_id = $1 AND property_id = $2 AND source_id = $3
        ORDER BY external_uid
      `,
      [validatedScope.organizationId, validatedScope.propertyId, source],
    );
    return Object.freeze(result.rows.map(mapRow));
  }

  async upsert(scope: ICalScope, record: ICalBlockRecord): Promise<ICalBlockRecord> {
    const validatedScope = validateScope(scope);
    const source = validateSourceId(record.sourceId);
    const next = validateRecord(scope, source, record);
    try {
      if (this.transaction !== undefined) {
        return await this.upsertInTransaction(this.transaction, next);
      }
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, validatedScope.organizationId, validatedScope.propertyId);
        await requireProperty(transaction, this.propertiesTable, validatedScope);
        return this.upsertInTransaction(transaction, next);
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError(
          'duplicate_availability_record',
          'iCalendar block already exists.',
        );
      }
      if (isPostgresError(error) && (error.code === '23P01' || error.code === '40P01')) {
        throw new PersistenceError(
          'availability_conflict',
          'iCalendar block overlaps a concurrently inserted availability record.',
        );
      }
      throw error;
    }
  }

  private async upsertInTransaction(
    transaction: PostgresTransactionPort,
    next: ICalBlockRecord,
  ): Promise<ICalBlockRecord> {
    await requireNoAvailabilityConflict(
      transaction,
      this.availabilityTable,
      next.organizationId,
      next.propertyId,
      next.arrival,
      next.departure,
    );
    const result = await transaction.query<ICalBlockRow>(
      `
        INSERT INTO ${this.blocksTable} AS ical_current (
          organization_id, property_id, source_id, external_uid,
          arrival, departure, status, event_status, sequence, last_modified, summary
        )
        VALUES ($1, $2, $3, $4, $5::date, $6::date, 'active', $7, $8, $9, $10)
        ON CONFLICT (organization_id, property_id, source_id, external_uid)
        DO UPDATE SET
          arrival = EXCLUDED.arrival,
          departure = EXCLUDED.departure,
          status = 'active',
          event_status = EXCLUDED.event_status,
          sequence = EXCLUDED.sequence,
          last_modified = EXCLUDED.last_modified,
          summary = EXCLUDED.summary,
          updated_at = CURRENT_TIMESTAMP
        WHERE (
          (ical_current.sequence IS NULL AND EXCLUDED.sequence IS NOT NULL)
          OR (
            ical_current.sequence IS NOT NULL
            AND EXCLUDED.sequence IS NOT NULL
            AND EXCLUDED.sequence > ical_current.sequence
          )
          OR (
            ical_current.sequence IS NOT DISTINCT FROM EXCLUDED.sequence
            AND (
              (
                ical_current.last_modified IS NULL
                AND EXCLUDED.last_modified IS NOT NULL
              )
              OR (
                ical_current.last_modified IS NOT NULL
                AND EXCLUDED.last_modified IS NOT NULL
                AND EXCLUDED.last_modified > ical_current.last_modified
              )
            )
          )
          OR (
            ical_current.status = 'active'
            AND ical_current.arrival IS NOT DISTINCT FROM EXCLUDED.arrival
            AND ical_current.departure IS NOT DISTINCT FROM EXCLUDED.departure
            AND ical_current.event_status IS NOT DISTINCT FROM EXCLUDED.event_status
            AND ical_current.sequence IS NOT DISTINCT FROM EXCLUDED.sequence
            AND ical_current.last_modified IS NOT DISTINCT FROM EXCLUDED.last_modified
            AND ical_current.summary IS NOT DISTINCT FROM EXCLUDED.summary
          )
        )
        RETURNING organization_id, property_id, source_id, external_uid,
                  arrival::text, departure::text, status, event_status,
                  sequence, last_modified, summary
      `,
      [
        next.organizationId,
        next.propertyId,
        next.sourceId,
        next.uid,
        next.arrival,
        next.departure,
        next.eventStatus,
        next.sequence,
        next.lastModified,
        next.summary,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ICalStaleWriteError();
    }
    return mapRow(row);
  }

  async release(
    scope: ICalScope,
    sourceId: string,
    uid: string,
    provenance?: ICalReleaseProvenance,
  ): Promise<boolean> {
    const validatedScope = validateScope(scope);
    const source = validateSourceId(sourceId);
    const externalUid = validateUid(uid);
    if (provenance !== undefined) {
      if (
        provenance.sequence !== null &&
        (!Number.isInteger(provenance.sequence) ||
          provenance.sequence < 0 ||
          provenance.sequence > ICAL_SEQUENCE_MAX)
      ) {
        throw new PersistenceError(
          'invalid_availability_id',
          'iCalendar cancellation sequence is invalid.',
        );
      }
      if (
        provenance.lastModified !== null &&
        (typeof provenance.lastModified !== 'string' ||
          Number.isNaN(Date.parse(provenance.lastModified)))
      ) {
        throw new PersistenceError(
          'invalid_availability_id',
          'iCalendar cancellation timestamp is invalid.',
        );
      }
      if (
        provenance.summary !== null &&
        (typeof provenance.summary !== 'string' ||
          provenance.summary.length > 2_000 ||
          hasUnsafeText(provenance.summary, true))
      ) {
        throw new PersistenceError(
          'invalid_availability_id',
          'iCalendar cancellation summary is invalid.',
        );
      }
    }
    try {
      if (this.transaction !== undefined) {
        return await this.releaseInTransaction(
          this.transaction,
          validatedScope,
          source,
          externalUid,
          provenance,
        );
      }
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, validatedScope.organizationId, validatedScope.propertyId);
        await requireProperty(transaction, this.propertiesTable, validatedScope);
        return this.releaseInTransaction(
          transaction,
          validatedScope,
          source,
          externalUid,
          provenance,
        );
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '40P01') {
        throw new PersistenceError(
          'availability_conflict',
          'iCalendar cancellation conflicted with a concurrent availability write.',
        );
      }
      throw error;
    }
  }

  private async releaseInTransaction(
    transaction: PostgresTransactionPort,
    scope: ICalScope,
    source: string,
    externalUid: string,
    provenance: ICalReleaseProvenance | undefined,
  ): Promise<boolean> {
    const result = await transaction.query(
      provenance === undefined
        ? `
            UPDATE ${this.blocksTable}
            SET status = 'released', event_status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE organization_id = $1 AND property_id = $2 AND source_id = $3
              AND external_uid = $4 AND status = 'active'
          `
        : `
            UPDATE ${this.blocksTable} AS current
            SET status = 'released', event_status = 'cancelled',
                sequence = $5, last_modified = $6, summary = $7,
                updated_at = CURRENT_TIMESTAMP
            WHERE organization_id = $1 AND property_id = $2 AND source_id = $3
              AND external_uid = $4 AND status IN ('active', 'released')
              AND (
                (current.sequence IS NULL AND $5::bigint IS NOT NULL)
                OR (
                  current.sequence IS NOT NULL
                  AND $5::bigint IS NOT NULL
                  AND $5::bigint > current.sequence
                )
                OR (
                  current.sequence IS NOT DISTINCT FROM $5::bigint
                  AND (
                    (
                      current.last_modified IS NULL
                      AND $6::timestamptz IS NOT NULL
                    )
                    OR (
                      current.last_modified IS NOT NULL
                      AND $6::timestamptz IS NOT NULL
                      AND $6::timestamptz > current.last_modified
                    )
                    OR current.last_modified IS NOT DISTINCT FROM $6::timestamptz
                  )
                )
              )
          `,
      provenance === undefined
        ? [scope.organizationId, scope.propertyId, source, externalUid]
        : [
            scope.organizationId,
            scope.propertyId,
            source,
            externalUid,
            provenance.sequence,
            provenance.lastModified,
            provenance.summary,
          ],
    );
    if (provenance === undefined || result.rowCount === 1) {
      return result.rowCount === 1;
    }
    const existing = await transaction.query(
      `
        SELECT 1
        FROM ${this.blocksTable}
        WHERE organization_id = $1 AND property_id = $2 AND source_id = $3
          AND external_uid = $4
      `,
      [scope.organizationId, scope.propertyId, source, externalUid],
    );
    if (existing.rowCount !== 0) {
      throw new ICalStaleWriteError();
    }
    return false;
  }

  async withReconciliation<T>(
    scope: ICalScope,
    sourceId: string,
    work: (store: ICalBlockStore) => Promise<T>,
  ): Promise<T> {
    const validatedScope = validateScope(scope);
    validateSourceId(sourceId);
    if (this.transaction !== undefined) {
      return work(this);
    }
    return this.database.withTransaction(async (transaction) => {
      // This is the same property lock acquired by native holds and iCalendar writes.
      // Keeping one lock order protects the full read/decision/write interval without
      // introducing a second advisory-lock cycle that could deadlock with inventory writes.
      await lockProperty(transaction, validatedScope.organizationId, validatedScope.propertyId);
      await requireProperty(transaction, this.propertiesTable, validatedScope);
      return work(new PostgresICalBlockStore(this.database, transaction));
    });
  }
}

export function createPostgresICalBlockStore(database: PostgresDatabasePort): ICalBlockStore {
  return new PostgresICalBlockStore(database);
}
