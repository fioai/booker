import { createHash, randomUUID } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import {
  createLocalDateInterval,
  createQuoteSnapshot,
  transitionBookingRequest,
  type BookingRequestAction,
  type BookingRequestStatus,
  type QuoteBreakdown,
  type QuoteSnapshotValidationError,
} from '@booking-engine/booking-core';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort, PostgresTransactionPort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

export interface BookingRequestOrganizationScope {
  readonly organizationId: string;
}

export interface BookingRequestCreateInput {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
  readonly guestCount: number;
  readonly guestName: string;
  readonly guestEmail: string;
  readonly message: string | null;
  readonly quote: QuoteBreakdown;
}

/** Client fields identify a retry without including the immutable server quote. */
export type BookingRequestClientInput = Pick<
  BookingRequestCreateInput,
  'arrival' | 'departure' | 'guestCount' | 'guestName' | 'guestEmail' | 'message'
>;

export interface BookingRequestSubmitOptions {
  readonly idempotencyKey: string;
  /** Public requests persist pending state without reserving inventory until owner approval. */
  readonly deferInventory?: boolean;
}

export interface BookingRequestRepositoryOptions {
  readonly clock?: () => Date;
  readonly holdDurationMs?: number;
}

export interface BookingRequestRecord extends BookingRequestCreateInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly status: BookingRequestStatus;
  readonly createdAt: string;
  readonly idempotencyKey?: string;
  readonly requestFingerprint?: string;
  readonly fingerprintVersion: 'legacy-md5-request-id' | 'sha256-v1';
  readonly holdRecordId?: string;
  readonly holdExpiresAt?: string;
  readonly decidedAt?: string;
}

export interface BookingRequestRecheckResult {
  readonly request: BookingRequestRecord;
  readonly available: boolean;
}

export interface BookingRequestRepository {
  findByIdempotencyKey(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    input: BookingRequestClientInput,
    idempotencyKey: string,
  ): Promise<BookingRequestRecord | null>;
  submit(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    input: BookingRequestCreateInput,
    options: BookingRequestSubmitOptions,
  ): Promise<BookingRequestRecord>;
  find(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord | null>;
  list(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
  ): Promise<readonly BookingRequestRecord[]>;
  approve(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord>;
  reject(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord>;
  recheckAvailability(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecheckResult>;
  expire(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
    at?: string | Date,
  ): Promise<BookingRequestRecord>;
}

interface BookingRequestRow extends QueryResultRow {
  readonly organization_id: unknown;
  readonly property_id: unknown;
  readonly request_id: unknown;
  readonly arrival: unknown;
  readonly departure: unknown;
  readonly guest_count: unknown;
  readonly guest_name: unknown;
  readonly guest_email: unknown;
  readonly message: unknown;
  readonly status: unknown;
  readonly quote_json: unknown;
  readonly created_at: unknown;
  readonly idempotency_key: unknown;
  readonly request_fingerprint: unknown;
  readonly fingerprint_version: unknown;
  readonly hold_record_id: unknown;
  readonly hold_expires_at: unknown;
  readonly decided_at: unknown;
}

interface HoldRow extends QueryResultRow {
  readonly record_id: unknown;
  readonly arrival: unknown;
  readonly departure: unknown;
  readonly expires_at: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_IDENTIFIER_LENGTH = 64;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_HOLD_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOLD_DURATION_MS = 15 * 60 * 1000;

function countUnicodeCodePoints(value: string, maximum = Number.POSITIVE_INFINITY): number {
  let length = 0;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    length += 1;
    if (length > maximum) {
      return length;
    }
  }
  return length;
}

const REQUEST_COLUMNS = `
  organization_id, property_id, request_id,
  arrival::text AS arrival, departure::text AS departure,
  guest_count, guest_name, guest_email, message, status, quote_json,
  created_at, idempotency_key, request_fingerprint, fingerprint_version, hold_record_id,
  hold_expires_at, decided_at
`;

function validateIdentifier(
  value: unknown,
  code: 'invalid_organization_id' | 'invalid_property_id' | 'invalid_booking_request_id',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    countUnicodeCodePoints(value, MAX_IDENTIFIER_LENGTH) > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PersistenceError(code, `${code} must be a valid identifier.`);
  }
}

function validateScope(scope: BookingRequestOrganizationScope): string {
  validateIdentifier(scope?.organizationId, 'invalid_organization_id');
  return scope.organizationId;
}

function validatePropertyId(propertyId: string): string {
  validateIdentifier(propertyId, 'invalid_property_id');
  return propertyId;
}

function validateRequestId(requestId: string): string {
  validateIdentifier(requestId, 'invalid_booking_request_id');
  return requestId;
}

function hasControlCharacters(value: string): boolean {
  for (let offset = 0; offset < value.length; offset += 1) {
    const codeUnit = value.charCodeAt(offset);
    if (codeUnit < 32 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

function validateIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    countUnicodeCodePoints(value, MAX_IDEMPOTENCY_KEY_LENGTH) > MAX_IDEMPOTENCY_KEY_LENGTH ||
    hasControlCharacters(value)
  ) {
    throw new PersistenceError(
      'booking_request_validation',
      'idempotencyKey is outside the public request bound.',
    );
  }
  return value.trim();
}

function parseTimestamp(value: unknown, field: string): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(typeof value === 'string' ? value : '');
  if (Number.isNaN(date.getTime())) {
    throw new PersistenceError('booking_request_validation', `${field} must be a valid timestamp.`);
  }
  return date;
}

function validateClientInput(input: BookingRequestClientInput): BookingRequestClientInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PersistenceError(
      'booking_request_validation',
      'booking request input must be an object.',
    );
  }
  const interval = createLocalDateInterval({
    arrival: input?.arrival,
    departure: input?.departure,
  });
  if (!interval.ok) {
    throw new PersistenceError(
      'invalid_stay',
      'booking request stay failed domain validation.',
      interval.errors,
    );
  }
  if (!Number.isSafeInteger(input?.guestCount) || input.guestCount < 1 || input.guestCount > 200) {
    throw new PersistenceError(
      'booking_request_validation',
      'guestCount is outside the public request bound.',
    );
  }
  if (
    typeof input?.guestName !== 'string' ||
    input.guestName.trim() === '' ||
    countUnicodeCodePoints(input.guestName, 120) > 120 ||
    hasControlCharacters(input.guestName)
  ) {
    throw new PersistenceError(
      'booking_request_validation',
      'guestName is outside the public request bound.',
    );
  }
  if (
    typeof input?.guestEmail !== 'string' ||
    countUnicodeCodePoints(input.guestEmail.trim(), 3) < 3 ||
    countUnicodeCodePoints(input.guestEmail, 254) > 254 ||
    hasControlCharacters(input.guestEmail) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.guestEmail)
  ) {
    throw new PersistenceError(
      'booking_request_validation',
      'guestEmail is outside the public request bound.',
    );
  }
  if (
    input.message !== null &&
    (typeof input.message !== 'string' ||
      input.message.trim() === '' ||
      countUnicodeCodePoints(input.message, 2000) > 2000 ||
      hasControlCharacters(input.message))
  ) {
    throw new PersistenceError(
      'booking_request_validation',
      'message is outside the public request bound.',
    );
  }
  return Object.freeze({
    arrival: interval.value.arrival,
    departure: interval.value.departure,
    guestCount: input.guestCount,
    guestName: input.guestName.trim(),
    guestEmail: input.guestEmail.trim(),
    message: input.message === null ? null : input.message.trim(),
  });
}

function validateInput(input: BookingRequestCreateInput): BookingRequestCreateInput & {
  readonly quote: QuoteBreakdown;
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PersistenceError(
      'booking_request_validation',
      'booking request input must be an object.',
    );
  }
  validateRequestId(input?.id);
  const client = validateClientInput(input);
  const snapshot = createQuoteSnapshot(input.quote);
  if (!snapshot.ok) {
    throw new PersistenceError(
      'booking_request_validation',
      'server quote snapshot failed validation.',
      snapshot.errors as readonly QuoteSnapshotValidationError[],
    );
  }
  if (snapshot.value.arrival !== client.arrival || snapshot.value.departure !== client.departure) {
    throw new PersistenceError(
      'booking_request_validation',
      'server quote snapshot does not match the requested stay.',
    );
  }
  return Object.freeze({
    ...input,
    ...client,
    quote: snapshot.value,
  });
}

function fingerprint(propertyId: string, input: BookingRequestCreateInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        propertyId,
        input.arrival,
        input.departure,
        input.guestCount,
        input.guestName,
        input.guestEmail,
        input.message,
        input.quote,
      ]),
    )
    .digest('hex');
}

function requireProperty(
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

function matchesNormalizedClientRequest(
  record: BookingRequestRecord,
  propertyId: string,
  request: BookingRequestClientInput,
): boolean {
  return (
    record.propertyId === propertyId &&
    record.arrival === request.arrival &&
    record.departure === request.departure &&
    record.guestCount === request.guestCount &&
    record.guestName.trim() === request.guestName.trim() &&
    record.guestEmail.trim() === request.guestEmail.trim() &&
    (record.message === null ? null : record.message.trim()) ===
      (request.message === null ? null : request.message.trim())
  );
}

function matchesNormalizedRequest(
  record: BookingRequestRecord,
  propertyId: string,
  request: BookingRequestCreateInput,
): boolean {
  return (
    matchesNormalizedClientRequest(record, propertyId, request) &&
    JSON.stringify(record.quote) === JSON.stringify(request.quote)
  );
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
      'stay overlaps an active availability record.',
    );
  }
}

async function insertOccupancy(
  transaction: PostgresTransactionPort,
  availabilityTable: string,
  organizationId: string,
  propertyId: string,
  requestId: string,
  arrival: string,
  departure: string,
  at: Date,
): Promise<void> {
  await transaction.query(
    `
      INSERT INTO ${availabilityTable} (
        organization_id, property_id, record_id, block_kind, status,
        stay, expires_at, created_at
      )
      VALUES ($1, $2, $3, 'occupancy', 'active', daterange($4::date, $5::date, '[)'), NULL, $6)
    `,
    [organizationId, propertyId, requestId, arrival, departure, at],
  );
}

function mapTimestamp(value: unknown, field: string): string {
  return parseTimestamp(value, field).toISOString();
}

function mapRow(row: BookingRequestRow): BookingRequestRecord {
  if (
    typeof row.organization_id !== 'string' ||
    typeof row.property_id !== 'string' ||
    typeof row.request_id !== 'string' ||
    typeof row.arrival !== 'string' ||
    typeof row.departure !== 'string' ||
    typeof row.guest_count !== 'number' ||
    !Number.isSafeInteger(row.guest_count) ||
    typeof row.guest_name !== 'string' ||
    typeof row.guest_email !== 'string' ||
    (row.message !== null && typeof row.message !== 'string') ||
    (row.status !== 'pending' &&
      row.status !== 'approved' &&
      row.status !== 'rejected' &&
      row.status !== 'expired') ||
    typeof row.idempotency_key !== 'string' ||
    typeof row.request_fingerprint !== 'string' ||
    (row.fingerprint_version !== 'legacy-md5-request-id' &&
      row.fingerprint_version !== 'sha256-v1') ||
    (row.hold_record_id !== null && typeof row.hold_record_id !== 'string') ||
    (row.hold_expires_at !== null &&
      !(row.hold_expires_at instanceof Date || typeof row.hold_expires_at === 'string')) ||
    !(row.created_at instanceof Date || typeof row.created_at === 'string') ||
    (row.decided_at !== null &&
      !(row.decided_at instanceof Date || typeof row.decided_at === 'string'))
  ) {
    throw new PersistenceError('database_corruption', 'booking request row has an invalid shape.');
  }
  const snapshot = createQuoteSnapshot(row.quote_json);
  if (!snapshot.ok) {
    throw new PersistenceError(
      'database_corruption',
      'booking request quote snapshot is invalid.',
      snapshot.errors as readonly QuoteSnapshotValidationError[],
    );
  }
  if (row.arrival !== snapshot.value.arrival || row.departure !== snapshot.value.departure) {
    throw new PersistenceError(
      'database_corruption',
      'booking request dates do not match the stored quote snapshot.',
    );
  }
  return Object.freeze({
    organizationId: row.organization_id,
    propertyId: row.property_id,
    id: row.request_id,
    arrival: row.arrival,
    departure: row.departure,
    guestCount: row.guest_count,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    message: row.message,
    status: row.status,
    quote: snapshot.value,
    createdAt: mapTimestamp(row.created_at, 'created_at'),
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    fingerprintVersion: row.fingerprint_version,
    ...(row.hold_record_id === null ? {} : { holdRecordId: row.hold_record_id }),
    ...(row.hold_expires_at === null
      ? {}
      : { holdExpiresAt: mapTimestamp(row.hold_expires_at, 'hold_expires_at') }),
    ...(row.decided_at === null ? {} : { decidedAt: mapTimestamp(row.decided_at, 'decided_at') }),
  });
}

type BookingOutboxEventType =
  | 'booking_request.submitted'
  | 'booking_request.approved'
  | 'booking_request.rejected'
  | 'booking_request.expired';

async function insertOutbox(
  transaction: PostgresTransactionPort,
  outboxTable: string,
  organizationId: string,
  propertyId: string,
  requestId: string,
  eventType: BookingOutboxEventType,
  status: BookingRequestStatus,
  quote: QuoteBreakdown,
  at: Date,
): Promise<void> {
  await transaction.query(
    `
      INSERT INTO ${outboxTable} (
        outbox_id, organization_id, property_id, request_id,
        event_type, payload, status, attempts, last_error_code, available_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 0, 'none', $7)
    `,
    [
      randomUUID(),
      organizationId,
      propertyId,
      requestId,
      eventType,
      JSON.stringify({
        requestId,
        propertyId,
        status,
        quote: { currency: quote.currency, totalMinor: quote.totalMinor },
      }),
      at,
    ],
  );
}

async function releaseHold(
  transaction: PostgresTransactionPort,
  availabilityTable: string,
  organizationId: string,
  propertyId: string,
  holdRecordId: string,
  at: Date,
): Promise<void> {
  await transaction.query(
    `
      UPDATE ${availabilityTable}
      SET status = 'released', released_at = $4
      WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        AND block_kind = 'hold' AND status = 'active'
    `,
    [organizationId, propertyId, holdRecordId, at],
  );
}

export class PostgresBookingRequestRepository implements BookingRequestRepository {
  private readonly requestsTable: string;
  private readonly outboxTable: string;
  private readonly availabilityTable: string;
  private readonly icalBlocksTable: string;
  private readonly propertiesTable: string;
  private readonly clock: () => Date;
  private readonly holdDurationMs: number;

  constructor(
    private readonly database: PostgresDatabasePort,
    options: BookingRequestRepositoryOptions = {},
  ) {
    this.requestsTable = qualifiedTable(database, 'booking_requests');
    this.outboxTable = qualifiedTable(database, 'booking_outbox');
    this.availabilityTable = qualifiedTable(database, 'availability_blocks');
    this.icalBlocksTable = qualifiedTable(database, 'ical_blocks');
    this.propertiesTable = qualifiedTable(database, 'properties');
    this.clock = options.clock ?? (() => new Date());
    this.holdDurationMs = options.holdDurationMs ?? DEFAULT_HOLD_DURATION_MS;
    if (
      !Number.isSafeInteger(this.holdDurationMs) ||
      this.holdDurationMs < 1_000 ||
      this.holdDurationMs > MAX_HOLD_DURATION_MS
    ) {
      throw new RangeError('booking request hold duration is outside the bounded range.');
    }
  }

  async findByIdempotencyKey(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    input: BookingRequestClientInput,
    idempotencyKey: string,
  ): Promise<BookingRequestRecord | null> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const request = validateClientInput(input);
    const key = validateIdempotencyKey(idempotencyKey);
    // Replay lookup must run before mutable property and quote validation.
    const result = await this.database.query<BookingRequestRow>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND idempotency_key = $2
      `,
      [organizationId, key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const record = mapRow(row);
    if (!matchesNormalizedClientRequest(record, property, request)) {
      throw new PersistenceError(
        'idempotency_key_reuse',
        'idempotency key was already used with a different request.',
      );
    }
    return record;
  }

  async submit(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    input: BookingRequestCreateInput,
    options: BookingRequestSubmitOptions,
  ): Promise<BookingRequestRecord> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const request = validateInput(input);
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new PersistenceError(
        'booking_request_validation',
        'booking request submission options must be an object.',
      );
    }
    const idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
    if (options.deferInventory !== undefined && typeof options.deferInventory !== 'boolean') {
      throw new PersistenceError(
        'booking_request_validation',
        'deferInventory must be a boolean when provided.',
      );
    }
    const deferInventory = options.deferInventory === true;
    const requestFingerprint = fingerprint(property, request);
    const submittedAt = parseTimestamp(this.clock(), 'clock');
    const holdExpiresAt = new Date(submittedAt.getTime() + this.holdDurationMs);
    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requireProperty(transaction, this.propertiesTable, organizationId, property);
        await this.expirePendingRequests(transaction, organizationId, property, submittedAt);

        const existing = await transaction.query<BookingRequestRow>(
          `
            SELECT ${REQUEST_COLUMNS}
            FROM ${this.requestsTable}
            WHERE organization_id = $1 AND idempotency_key = $2
            FOR UPDATE
          `,
          [organizationId, idempotencyKey],
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined) {
          const existingRecord = mapRow(existingRow);
          const matchesExisting =
            existingRecord.fingerprintVersion === 'legacy-md5-request-id'
              ? matchesNormalizedRequest(existingRecord, property, request)
              : existingRecord.requestFingerprint === requestFingerprint;
          if (!matchesExisting) {
            throw new PersistenceError(
              'idempotency_key_reuse',
              'idempotency key was already used with a different request.',
            );
          }
          if (existingRecord.fingerprintVersion === 'legacy-md5-request-id') {
            const upgraded = await transaction.query<BookingRequestRow>(
              `
                UPDATE ${this.requestsTable}
                SET request_fingerprint = $4,
                    fingerprint_version = 'sha256-v1',
                    updated_at = $5
                WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
                RETURNING ${REQUEST_COLUMNS}
              `,
              [organizationId, property, existingRecord.id, requestFingerprint, submittedAt],
            );
            const upgradedRow = upgraded.rows[0];
            if (upgradedRow === undefined) {
              throw new PersistenceError(
                'database_corruption',
                'legacy booking request upgrade returned no row.',
              );
            }
            return mapRow(upgradedRow);
          }
          return existingRecord;
        }

        const inserted = await transaction.query<BookingRequestRow>(
          `
            INSERT INTO ${this.requestsTable} (
              organization_id, property_id, request_id,
              arrival, departure, guest_count, guest_name, guest_email, message,
              status, quote_json, idempotency_key, request_fingerprint, fingerprint_version,
              hold_record_id, hold_expires_at, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4::date, $5::date, $6, $7, $8, $9,
              'pending', $10::jsonb, $11, $12, 'sha256-v1', $13, $14, $15, $15
            )
            RETURNING ${REQUEST_COLUMNS}
          `,
          [
            organizationId,
            property,
            request.id,
            request.arrival,
            request.departure,
            request.guestCount,
            request.guestName,
            request.guestEmail,
            request.message,
            JSON.stringify(request.quote),
            idempotencyKey,
            requestFingerprint,
            deferInventory ? null : request.id,
            holdExpiresAt,
            submittedAt,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow === undefined) {
          throw new PersistenceError(
            'database_corruption',
            'booking request insert returned no row.',
          );
        }

        if (!deferInventory) {
          await requireNoICalConflict(
            transaction,
            this.icalBlocksTable,
            organizationId,
            property,
            request.arrival,
            request.departure,
          );
          await transaction.query(
            `
              INSERT INTO ${this.availabilityTable} (
                organization_id, property_id, record_id, block_kind, status,
                stay, expires_at, created_at
              )
              VALUES ($1, $2, $3, 'hold', 'active', daterange($4::date, $5::date, '[)'), $6, $7)
            `,
            [
              organizationId,
              property,
              request.id,
              request.arrival,
              request.departure,
              holdExpiresAt,
              submittedAt,
            ],
          );
        }
        await insertOutbox(
          transaction,
          this.outboxTable,
          organizationId,
          property,
          request.id,
          'booking_request.submitted',
          'pending',
          request.quote,
          submittedAt,
        );
        return mapRow(insertedRow);
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
      if (isPostgresError(error) && error.code === '23505') {
        if (error.constraint === 'booking_requests_idempotency_key_uq') {
          throw new PersistenceError(
            'idempotency_key_reuse',
            'idempotency key was already used with a different request.',
          );
        }
        throw new PersistenceError('duplicate_booking_request', 'booking request already exists.');
      }
      throw error;
    }
  }

  async find(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord | null> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRequestId(requestId);
    await this.database.withTransaction((transaction) =>
      requireProperty(transaction, this.propertiesTable, organizationId, property),
    );
    const result = await this.database.query<BookingRequestRow>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
      `,
      [organizationId, property, id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async list(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
  ): Promise<readonly BookingRequestRecord[]> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    await this.database.withTransaction((transaction) =>
      requireProperty(transaction, this.propertiesTable, organizationId, property),
    );
    const result = await this.database.query<BookingRequestRow>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND property_id = $2
        ORDER BY created_at DESC, request_id DESC
        LIMIT 100
      `,
      [organizationId, property],
    );
    return Object.freeze(result.rows.map(mapRow));
  }

  async approve(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord> {
    return this.transition(scope, propertyId, requestId, 'approve');
  }

  async reject(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord> {
    return this.transition(scope, propertyId, requestId, 'reject');
  }

  async recheckAvailability(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecheckResult> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRequestId(requestId);
    const at = parseTimestamp(this.clock(), 'clock');
    return this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, property);
      await requireProperty(transaction, this.propertiesTable, organizationId, property);
      const record = await this.loadForUpdate(transaction, organizationId, property, id);
      if (record === null) {
        throw new PersistenceError('booking_request_not_found', 'booking request was not found.');
      }
      if (record.status !== 'pending') {
        return { request: record, available: false };
      }
      if (this.isExpired(record, at)) {
        return { request: await this.expireLoaded(transaction, record, at), available: false };
      }
      if (record.holdRecordId === undefined) {
        try {
          await requireNoAvailabilityConflict(
            transaction,
            this.availabilityTable,
            organizationId,
            property,
            record.arrival,
            record.departure,
          );
          await requireNoICalConflict(
            transaction,
            this.icalBlocksTable,
            organizationId,
            property,
            record.arrival,
            record.departure,
          );
        } catch (error) {
          if (error instanceof PersistenceError && error.code === 'availability_conflict') {
            return { request: record, available: false };
          }
          throw error;
        }
        return { request: record, available: true };
      }
      const hold = await this.loadActiveHold(transaction, organizationId, property, record, at);
      if (hold === null) {
        return { request: await this.expireLoaded(transaction, record, at), available: false };
      }
      try {
        await requireNoICalConflict(
          transaction,
          this.icalBlocksTable,
          organizationId,
          property,
          hold.arrival as string,
          hold.departure as string,
        );
      } catch (error) {
        if (error instanceof PersistenceError && error.code === 'availability_conflict') {
          return { request: record, available: false };
        }
        throw error;
      }
      return { request: record, available: true };
    });
  }

  async expire(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
    at?: string | Date,
  ): Promise<BookingRequestRecord> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRequestId(requestId);
    const timestamp = parseTimestamp(at ?? this.clock(), 'at');
    return this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, property);
      await requireProperty(transaction, this.propertiesTable, organizationId, property);
      const record = await this.loadForUpdate(transaction, organizationId, property, id);
      if (record === null) {
        throw new PersistenceError('booking_request_not_found', 'booking request was not found.');
      }
      if (record.status !== 'pending') {
        throw new PersistenceError(
          'invalid_booking_request_transition',
          'booking request is no longer pending.',
        );
      }
      if (!this.isExpired(record, timestamp)) {
        throw new PersistenceError(
          'booking_request_expired',
          'booking request hold has not expired.',
        );
      }
      return this.expireLoaded(transaction, record, timestamp);
    });
  }

  private isExpired(record: BookingRequestRecord, at: Date): boolean {
    return (
      record.holdExpiresAt !== undefined &&
      parseTimestamp(record.holdExpiresAt, 'hold_expires_at') <= at
    );
  }

  private async loadForUpdate(
    transaction: PostgresTransactionPort,
    organizationId: string,
    propertyId: string,
    requestId: string,
  ): Promise<BookingRequestRecord | null> {
    const result = await transaction.query<BookingRequestRow>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
        FOR UPDATE
      `,
      [organizationId, propertyId, requestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  private async loadActiveHold(
    transaction: PostgresTransactionPort,
    organizationId: string,
    propertyId: string,
    record: BookingRequestRecord,
    at: Date,
  ): Promise<HoldRow | null> {
    if (record.holdRecordId === undefined) {
      return null;
    }
    const result = await transaction.query<HoldRow>(
      `
        SELECT record_id, lower(stay)::text AS arrival, upper(stay)::text AS departure, expires_at
        FROM ${this.availabilityTable}
        WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
          AND block_kind = 'hold' AND status = 'active' AND expires_at > $4
        FOR UPDATE
      `,
      [organizationId, propertyId, record.holdRecordId, at],
    );
    return result.rows[0] ?? null;
  }

  private async transition(
    scope: BookingRequestOrganizationScope,
    propertyId: string,
    requestId: string,
    action: BookingRequestAction,
  ): Promise<BookingRequestRecord> {
    const organizationId = validateScope(scope);
    const property = validatePropertyId(propertyId);
    const id = validateRequestId(requestId);
    const at = parseTimestamp(this.clock(), 'clock');
    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requireProperty(transaction, this.propertiesTable, organizationId, property);
        const record = await this.loadForUpdate(transaction, organizationId, property, id);
        if (record === null) {
          throw new PersistenceError('booking_request_not_found', 'booking request was not found.');
        }
        if (record.status !== 'pending') {
          throw new PersistenceError(
            'invalid_booking_request_transition',
            `cannot ${action} a ${record.status} booking request.`,
          );
        }
        if (this.isExpired(record, at)) {
          return this.expireLoaded(transaction, record, at);
        }
        const next = transitionBookingRequest(record.status, action);
        if (!next.ok) {
          throw new PersistenceError(
            'invalid_booking_request_transition',
            `cannot ${action} a ${record.status} booking request.`,
          );
        }
        if (action === 'approve') {
          if (record.holdRecordId === undefined) {
            await requireNoAvailabilityConflict(
              transaction,
              this.availabilityTable,
              organizationId,
              property,
              record.arrival,
              record.departure,
            );
            await requireNoICalConflict(
              transaction,
              this.icalBlocksTable,
              organizationId,
              property,
              record.arrival,
              record.departure,
            );
            await insertOccupancy(
              transaction,
              this.availabilityTable,
              organizationId,
              property,
              record.id,
              record.arrival,
              record.departure,
              at,
            );
          } else {
            const hold = await this.loadActiveHold(
              transaction,
              organizationId,
              property,
              record,
              at,
            );
            if (hold === null) {
              return this.expireLoaded(transaction, record, at);
            }
            await requireNoICalConflict(
              transaction,
              this.icalBlocksTable,
              organizationId,
              property,
              hold.arrival as string,
              hold.departure as string,
            );
            const promoted = await transaction.query(
              `
                UPDATE ${this.availabilityTable}
                SET block_kind = 'occupancy', expires_at = NULL
                WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
                  AND block_kind = 'hold' AND status = 'active'
              `,
              [organizationId, property, record.holdRecordId],
            );
            if (promoted.rowCount !== 1) {
              throw new PersistenceError(
                'booking_request_expired',
                'booking request hold is no longer active.',
              );
            }
          }
        } else if (record.holdRecordId !== undefined) {
          await releaseHold(
            transaction,
            this.availabilityTable,
            organizationId,
            property,
            record.holdRecordId,
            at,
          );
        }
        const inventoryRecordId =
          action === 'approve' ? (record.holdRecordId ?? record.id) : record.holdRecordId;
        const updated = await transaction.query<BookingRequestRow>(
          `
            UPDATE ${this.requestsTable}
            SET status = $4, hold_record_id = COALESCE($6, hold_record_id),
                decided_at = $5, updated_at = $5
            WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
              AND status = 'pending'
            RETURNING ${REQUEST_COLUMNS}
          `,
          [organizationId, property, id, next.value, at, inventoryRecordId ?? null],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new PersistenceError(
            'invalid_booking_request_transition',
            'booking request transition was not applied.',
          );
        }
        const saved = mapRow(updatedRow);
        await insertOutbox(
          transaction,
          this.outboxTable,
          organizationId,
          property,
          id,
          action === 'approve' ? 'booking_request.approved' : 'booking_request.rejected',
          next.value,
          saved.quote,
          at,
        );
        return saved;
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23P01') {
        throw new PersistenceError(
          'availability_conflict',
          'approval overlaps an active availability record.',
        );
      }
      throw error;
    }
  }

  private async expireLoaded(
    transaction: PostgresTransactionPort,
    record: BookingRequestRecord,
    at: Date,
  ): Promise<BookingRequestRecord> {
    const next = transitionBookingRequest(record.status, 'expire');
    if (!next.ok) {
      throw new PersistenceError(
        'invalid_booking_request_transition',
        'only a pending booking request can expire.',
      );
    }
    if (record.holdRecordId !== undefined) {
      await releaseHold(
        transaction,
        this.availabilityTable,
        record.organizationId,
        record.propertyId,
        record.holdRecordId,
        at,
      );
    }
    const updated = await transaction.query<BookingRequestRow>(
      `
        UPDATE ${this.requestsTable}
        SET status = 'expired', decided_at = $4, updated_at = $4
        WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
          AND status = 'pending'
        RETURNING ${REQUEST_COLUMNS}
      `,
      [record.organizationId, record.propertyId, record.id, at],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      throw new PersistenceError(
        'invalid_booking_request_transition',
        'booking request expired twice.',
      );
    }
    const saved = mapRow(row);
    await insertOutbox(
      transaction,
      this.outboxTable,
      record.organizationId,
      record.propertyId,
      record.id,
      'booking_request.expired',
      'expired',
      saved.quote,
      at,
    );
    return saved;
  }

  private async expirePendingRequests(
    transaction: PostgresTransactionPort,
    organizationId: string,
    propertyId: string,
    at: Date,
  ): Promise<void> {
    const result = await transaction.query<BookingRequestRow>(
      `
        SELECT ${REQUEST_COLUMNS}
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND property_id = $2
          AND status = 'pending' AND hold_expires_at <= $3
        ORDER BY request_id
        FOR UPDATE
      `,
      [organizationId, propertyId, at],
    );
    for (const row of result.rows) {
      await this.expireLoaded(transaction, mapRow(row), at);
    }
    await transaction.query(
      `
        UPDATE ${this.availabilityTable}
        SET status = 'released', released_at = $3
        WHERE organization_id = $1 AND property_id = $2
          AND block_kind = 'hold' AND status = 'active' AND expires_at <= $3
      `,
      [organizationId, propertyId, at],
    );
  }
}

export function createPostgresBookingRequestRepository(
  database: PostgresDatabasePort,
  options?: BookingRequestRepositoryOptions,
): BookingRequestRepository {
  return new PostgresBookingRequestRepository(database, options);
}
