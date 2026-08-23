import type { QueryResultRow } from 'pg';

import { PersistenceError } from './persistence-errors.js';
import type { PostgresDatabasePort } from './postgres-database.js';
import { qualifiedTable } from './sql-identifiers.js';

export type BookingOutboxEventTypeV1 =
  | 'booking_request.submitted'
  | 'booking_request.approved'
  | 'booking_request.rejected'
  | 'booking_request.expired';

export type BookingOutboxStatusV1 = 'pending' | 'processing' | 'delivered' | 'failed';

export type OutboxDeliveryErrorCodeV1 = 'temporary' | 'permanent';

export class OutboxDeliveryErrorV1 extends Error {
  readonly code: OutboxDeliveryErrorCodeV1;

  constructor(code: OutboxDeliveryErrorCodeV1, message: string) {
    super(message);
    this.name = 'OutboxDeliveryErrorV1';
    this.code = code;
  }
}

export interface BookingOutboxDeliveryEventV1 {
  readonly outboxId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly requestId: string;
  readonly eventType: BookingOutboxEventTypeV1;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

export interface BookingOutboxDeliveryPortV1 {
  deliver(event: BookingOutboxDeliveryEventV1): Promise<void>;
}

export type OutboxDeliveryPortV1 = BookingOutboxDeliveryPortV1;

export interface BookingOutboxRepositoryOptionsV1 {
  readonly clock?: () => Date;
  readonly maxAttempts?: number;
  readonly processingTimeoutMs?: number;
}

export interface BookingOutboxDeliverySummaryV1 {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface BookingOutboxRepositoryV1 {
  deliverPending(
    delivery: BookingOutboxDeliveryPortV1,
    options?: { readonly limit?: number },
  ): Promise<BookingOutboxDeliverySummaryV1>;
}

interface BookingOutboxRow extends QueryResultRow {
  readonly outbox_id: unknown;
  readonly organization_id: unknown;
  readonly property_id: unknown;
  readonly request_id: unknown;
  readonly event_type: unknown;
  readonly payload: unknown;
  readonly status: unknown;
  readonly attempts: unknown;
  readonly last_error_code: unknown;
  readonly last_error: unknown;
  readonly available_at: unknown;
  readonly locked_at: unknown;
  readonly delivered_at: unknown;
  readonly created_at: unknown;
}

const MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function parseTimestamp(value: unknown, field: string): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(typeof value === 'string' ? value : '');
  if (Number.isNaN(date.getTime())) {
    throw new PersistenceError('database_corruption', `${field} is not a valid timestamp.`);
  }
  return date;
}

function parsePayload(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceError('database_corruption', 'outbox payload is not an object.');
  }
  return Object.freeze({ ...(parsed as Record<string, unknown>) });
}

function mapRow(row: BookingOutboxRow): BookingOutboxDeliveryEventV1 {
  if (
    typeof row.outbox_id !== 'string' ||
    typeof row.organization_id !== 'string' ||
    typeof row.property_id !== 'string' ||
    typeof row.request_id !== 'string' ||
    (row.event_type !== 'booking_request.submitted' &&
      row.event_type !== 'booking_request.approved' &&
      row.event_type !== 'booking_request.rejected' &&
      row.event_type !== 'booking_request.expired') ||
    row.status !== 'processing' ||
    typeof row.attempts !== 'number' ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 1 ||
    row.attempts > MAX_ATTEMPTS
  ) {
    throw new PersistenceError('database_corruption', 'outbox row has an invalid shape.');
  }
  parseTimestamp(row.available_at, 'available_at');
  return Object.freeze({
    outboxId: row.outbox_id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    requestId: row.request_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload),
    attempts: row.attempts,
  });
}

function limitValue(value: number | undefined): number {
  const limit = value ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('outbox delivery limit must be an integer from 1 to 100.');
  }
  return limit;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'outbox delivery failed.';
  return [...message]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 1000);
}

export class PostgresBookingOutboxRepository implements BookingOutboxRepositoryV1 {
  private readonly outboxTable: string;
  private readonly clock: () => Date;
  private readonly maxAttempts: number;
  private readonly processingTimeoutMs: number;

  constructor(
    private readonly database: PostgresDatabasePort,
    options: BookingOutboxRepositoryOptionsV1 = {},
  ) {
    this.outboxTable = qualifiedTable(database, 'booking_outbox');
    this.clock = options.clock ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.processingTimeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > MAX_ATTEMPTS
    ) {
      throw new RangeError(`outbox maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
    }
    if (!Number.isSafeInteger(this.processingTimeoutMs) || this.processingTimeoutMs < 1_000) {
      throw new RangeError('outbox processing timeout must be at least one second.');
    }
  }

  async deliverPending(
    delivery: BookingOutboxDeliveryPortV1,
    options: { readonly limit?: number } = {},
  ): Promise<BookingOutboxDeliverySummaryV1> {
    const limit = limitValue(options.limit);
    let claimed = 0;
    let delivered = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const at = parseTimestamp(this.clock(), 'clock');
      const staleBefore = new Date(at.getTime() - this.processingTimeoutMs);
      const event = await this.claimOne(at, staleBefore);
      if (event === null) {
        break;
      }
      claimed += 1;
      try {
        await delivery.deliver(event);
        await this.markDelivered(event.outboxId, at);
        delivered += 1;
      } catch (error) {
        const deliveryCode = error instanceof OutboxDeliveryErrorV1 ? error.code : 'temporary';
        const permanentlyFailed =
          deliveryCode === 'permanent' || event.attempts >= this.maxAttempts;
        await this.markFailed(
          event.outboxId,
          event.attempts,
          deliveryCode,
          permanentlyFailed,
          at,
          errorMessage(error),
        );
        if (permanentlyFailed) {
          failed += 1;
        }
      }
    }
    return { claimed, delivered, failed };
  }

  private async claimOne(
    at: Date,
    staleBefore: Date,
  ): Promise<BookingOutboxDeliveryEventV1 | null> {
    return this.database.withTransaction(async (transaction) => {
      await transaction.query(
        `
          UPDATE ${this.outboxTable}
          SET status = 'failed', locked_at = NULL,
              last_error_code = 'max_attempts',
              last_error = 'outbox delivery attempts exhausted'
          WHERE status = 'processing' AND attempts >= $2
            AND locked_at IS NOT NULL AND locked_at <= $1
        `,
        [staleBefore, this.maxAttempts],
      );
      const result = await transaction.query<BookingOutboxRow>(
        `
          SELECT outbox_id, organization_id, property_id, request_id, event_type,
                 payload, status, attempts, last_error_code, last_error,
                 available_at, locked_at, delivered_at, created_at
          FROM ${this.outboxTable}
          WHERE attempts < $3
            AND (
              (status = 'pending' AND available_at <= $1)
              OR (status = 'processing' AND locked_at IS NOT NULL AND locked_at <= $2)
            )
          ORDER BY created_at, outbox_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [at, staleBefore, this.maxAttempts],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const updated = await transaction.query<BookingOutboxRow>(
        `
          UPDATE ${this.outboxTable}
          SET status = 'processing', attempts = attempts + 1, locked_at = $2
          WHERE outbox_id = $1 AND attempts < $3
          RETURNING outbox_id, organization_id, property_id, request_id, event_type,
                    payload, status, attempts, last_error_code, last_error,
                    available_at, locked_at, delivered_at, created_at
        `,
        [row.outbox_id, at, this.maxAttempts],
      );
      const updatedRow = updated.rows[0];
      return updatedRow === undefined ? null : mapRow(updatedRow);
    });
  }

  private async markDelivered(outboxId: string, at: Date): Promise<void> {
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `
          UPDATE ${this.outboxTable}
          SET status = 'delivered', delivered_at = $2, locked_at = NULL,
              last_error_code = 'none', last_error = NULL
          WHERE outbox_id = $1 AND status = 'processing'
        `,
        [outboxId, at],
      );
      if (result.rowCount !== 1) {
        throw new PersistenceError(
          'outbox_delivery_failed',
          'outbox delivery acknowledgement was lost.',
        );
      }
    });
  }

  private async markFailed(
    outboxId: string,
    attempts: number,
    deliveryCode: OutboxDeliveryErrorCodeV1,
    permanentlyFailed: boolean,
    at: Date,
    message: string,
  ): Promise<void> {
    const status: BookingOutboxStatusV1 = permanentlyFailed ? 'failed' : 'pending';
    const errorCode = permanentlyFailed
      ? deliveryCode === 'permanent'
        ? 'permanent'
        : 'max_attempts'
      : 'temporary';
    await this.database.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `
          UPDATE ${this.outboxTable}
          SET status = $2, available_at = $3, locked_at = NULL,
              last_error_code = $4, last_error = $5
          WHERE outbox_id = $1 AND status = 'processing' AND attempts = $6
        `,
        [outboxId, status, at, errorCode, message, attempts],
      );
      if (result.rowCount !== 1) {
        throw new PersistenceError(
          'outbox_delivery_failed',
          'outbox failure acknowledgement was lost.',
        );
      }
    });
  }
}

export function createPostgresBookingOutboxRepository(
  database: PostgresDatabasePort,
  options?: BookingOutboxRepositoryOptionsV1,
): BookingOutboxRepositoryV1 {
  return new PostgresBookingOutboxRepository(database, options);
}
