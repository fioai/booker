import { createHash, randomUUID } from 'node:crypto';

import type { QueryResultRow } from 'pg';

import {
  createPaymentCheckoutRequest,
  paymentStateTransition,
  type MoneyMinor,
  type PaymentCheckoutPreparation,
  type PaymentCheckoutRecord,
  type PaymentCheckoutSession,
  type PaymentCheckoutStore,
  type PaymentOrganizationScope,
  type PaymentProviderRegistration,
  type PaymentState,
  type PaymentWebhookEvent,
  type PaymentWebhookProcessingResult,
  type PaymentWebhookProcessingStatus,
} from '@booking-engine/payments';
import { createQuoteSnapshot, type QuoteBreakdown } from '@booking-engine/booking-core';

import { PersistenceError, isPostgresError } from '../database/errors.js';
import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort, PostgresTransactionPort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

export type {
  PaymentCheckoutPreparation,
  PaymentCheckoutRecord,
  PaymentOrganizationScope,
  PaymentProviderRegistration,
  PaymentWebhookProcessingResult,
  PaymentWebhookProcessingStatus,
} from '@booking-engine/payments';

export interface PaymentCheckoutRepositoryOptions {
  readonly clock?: () => Date;
  readonly checkoutDurationMs?: number;
  readonly maxCheckoutAttempts?: number;
}

export interface PaymentCheckoutRepository extends PaymentCheckoutStore {
  findCheckout(
    scope: PaymentOrganizationScope,
    propertyId: string,
    checkoutId: string,
  ): Promise<PaymentCheckoutRecord | null>;
}

interface ApprovedRequestRow extends QueryResultRow {
  readonly organization_id: unknown;
  readonly property_id: unknown;
  readonly request_id: unknown;
  readonly status: unknown;
  readonly quote_json: unknown;
  readonly hold_record_id: unknown;
}

interface InventoryRow extends QueryResultRow {
  readonly block_kind: unknown;
  readonly status: unknown;
}

interface PaymentCheckoutRow extends QueryResultRow {
  readonly checkout_id: unknown;
  readonly organization_id: unknown;
  readonly property_id: unknown;
  readonly request_id: unknown;
  readonly hold_record_id: unknown;
  readonly provider: unknown;
  readonly provider_account_id: unknown;
  readonly provider_session_id: unknown;
  readonly provider_payment_id: unknown;
  readonly amount_minor: unknown;
  readonly currency: unknown;
  readonly quote_revision: unknown;
  readonly state: unknown;
  readonly failure_code: unknown;
  readonly checkout_expires_at: unknown;
  readonly paid_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface PaymentProviderEventRow extends QueryResultRow {
  readonly payload_hash: unknown;
  readonly provider_account_id: unknown;
  readonly processing_status: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u;
const CHECKOUT_DURATION_DEFAULT_MS = 15 * 60 * 1000;
const CHECKOUT_DURATION_MAX_MS = 24 * 60 * 60 * 1000;
const CHECKOUT_ATTEMPTS_DEFAULT = 3;
const CHECKOUT_ATTEMPTS_MAX = 5;

const CHECKOUT_COLUMNS = `
  checkout_id, organization_id, property_id, request_id, hold_record_id,
  provider, provider_account_id, provider_session_id, provider_payment_id,
  amount_minor, currency, quote_revision, state, failure_code,
  checkout_expires_at, paid_at, created_at, updated_at
`;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new PersistenceError('payment_validation', `${field} is outside the payment bound.`);
  }
  return value;
}

function validateProvider(value: PaymentProviderRegistration): PaymentProviderRegistration {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.providerName !== 'string' ||
    !PROVIDER_PATTERN.test(value.providerName) ||
    typeof value.providerAccountId !== 'string' ||
    !ACCOUNT_PATTERN.test(value.providerAccountId)
  ) {
    throw new PersistenceError('payment_validation', 'payment provider registration is invalid.');
  }
  return Object.freeze({
    providerName: value.providerName,
    providerAccountId: value.providerAccountId,
  });
}

function timestamp(value: unknown, field: string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(result.getTime())) {
    throw new PersistenceError('payment_validation', `${field} is not a valid timestamp.`);
  }
  return result;
}

function mapTimestamp(value: unknown, field: string): string {
  return timestamp(value, field).toISOString();
}

function parseAmount(value: unknown): MoneyMinor {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > 1_000_000_000
  ) {
    throw new PersistenceError('payment_event_rejected', 'payment amount is outside the bound.');
  }
  return amount as MoneyMinor;
}

function mapState(value: unknown): PaymentState {
  if (
    value !== 'created' &&
    value !== 'open' &&
    value !== 'paid' &&
    value !== 'failed' &&
    value !== 'expired' &&
    value !== 'rejected'
  ) {
    throw new PersistenceError('database_corruption', 'payment checkout state is invalid.');
  }
  return value;
}

function mapCheckout(row: PaymentCheckoutRow): PaymentCheckoutRecord {
  if (
    typeof row.checkout_id !== 'string' ||
    typeof row.organization_id !== 'string' ||
    typeof row.property_id !== 'string' ||
    typeof row.request_id !== 'string' ||
    typeof row.hold_record_id !== 'string' ||
    typeof row.provider !== 'string' ||
    typeof row.provider_account_id !== 'string' ||
    (row.provider_session_id !== null && typeof row.provider_session_id !== 'string') ||
    (row.provider_payment_id !== null && typeof row.provider_payment_id !== 'string') ||
    typeof row.currency !== 'string' ||
    typeof row.quote_revision !== 'string' ||
    (row.failure_code !== null && typeof row.failure_code !== 'string') ||
    (row.paid_at !== null && !(row.paid_at instanceof Date || typeof row.paid_at === 'string'))
  ) {
    throw new PersistenceError('database_corruption', 'payment checkout row has an invalid shape.');
  }
  return Object.freeze({
    checkoutId: row.checkout_id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    requestId: row.request_id,
    holdId: row.hold_record_id,
    providerName: row.provider,
    providerAccountId: row.provider_account_id,
    providerSessionId: row.provider_session_id,
    providerPaymentId: row.provider_payment_id,
    amountMinor: parseAmount(row.amount_minor),
    currency: row.currency,
    quoteRevision: row.quote_revision,
    state: mapState(row.state),
    failureCode: row.failure_code,
    checkoutExpiresAt: mapTimestamp(row.checkout_expires_at, 'checkout_expires_at'),
    paidAt: row.paid_at === null ? null : mapTimestamp(row.paid_at, 'paid_at'),
    createdAt: mapTimestamp(row.created_at, 'created_at'),
    updatedAt: mapTimestamp(row.updated_at, 'updated_at'),
  });
}

function quoteRevision(quote: QuoteBreakdown): string {
  return createHash('sha256').update(JSON.stringify(quote)).digest('hex');
}

function webhookEventHash(event: PaymentWebhookEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerName: event.providerName,
        providerEventId: event.providerEventId,
        providerAccountId: event.providerAccountId,
        eventType: event.eventType,
        providerSessionId: event.providerSessionId,
        providerPaymentId: event.providerPaymentId,
        amountMinor: event.amountMinor,
        currency: event.currency,
        metadata: {
          organizationId: event.metadata.organizationId,
          propertyId: event.metadata.propertyId,
          requestId: event.metadata.requestId,
          holdId: event.metadata.holdId,
          quoteRevision: event.metadata.quoteRevision,
        },
        occurredAt: event.occurredAt,
      }),
    )
    .digest('hex');
}

function validateWebhookEvent(event: PaymentWebhookEvent): PaymentWebhookEvent {
  if (
    typeof event !== 'object' ||
    event === null ||
    typeof event.providerName !== 'string' ||
    !PROVIDER_PATTERN.test(event.providerName) ||
    typeof event.providerEventId !== 'string' ||
    !EVENT_ID_PATTERN.test(event.providerEventId) ||
    typeof event.providerAccountId !== 'string' ||
    !ACCOUNT_PATTERN.test(event.providerAccountId) ||
    (event.eventType !== 'succeeded' &&
      event.eventType !== 'failed' &&
      event.eventType !== 'expired') ||
    typeof event.providerSessionId !== 'string' ||
    !SESSION_PATTERN.test(event.providerSessionId) ||
    (event.providerPaymentId !== null &&
      (typeof event.providerPaymentId !== 'string' ||
        !SESSION_PATTERN.test(event.providerPaymentId))) ||
    typeof event.currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(event.currency) ||
    typeof event.metadata !== 'object' ||
    event.metadata === null ||
    typeof event.metadata.organizationId !== 'string' ||
    !IDENTIFIER_PATTERN.test(event.metadata.organizationId) ||
    typeof event.metadata.propertyId !== 'string' ||
    !IDENTIFIER_PATTERN.test(event.metadata.propertyId) ||
    typeof event.metadata.requestId !== 'string' ||
    !IDENTIFIER_PATTERN.test(event.metadata.requestId) ||
    typeof event.metadata.holdId !== 'string' ||
    !IDENTIFIER_PATTERN.test(event.metadata.holdId) ||
    typeof event.metadata.quoteRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(event.metadata.quoteRevision)
  ) {
    throw new PersistenceError('payment_event_rejected', 'payment webhook event is invalid.');
  }
  const amountMinor = parseAmount(event.amountMinor);
  const occurredAt = mapTimestamp(event.occurredAt, 'occurred_at');
  return Object.freeze({
    ...event,
    amountMinor,
    occurredAt,
  });
}

function requireDateClock(clock: () => Date): Date {
  return timestamp(clock(), 'clock');
}

function requireProperty(
  transaction: PostgresTransactionPort,
  propertiesTable: string,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  return transaction
    .query(`SELECT id FROM ${propertiesTable} WHERE organization_id = $1 AND id = $2`, [
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

export class PostgresPaymentCheckoutRepository implements PaymentCheckoutRepository {
  private readonly checkoutsTable: string;
  private readonly propertiesTable: string;
  private readonly requestsTable: string;
  private readonly availabilityTable: string;
  private readonly eventsTable: string;
  private readonly clock: () => Date;
  private readonly checkoutDurationMs: number;
  private readonly maxCheckoutAttempts: number;

  constructor(
    private readonly database: PostgresDatabasePort,
    options: PaymentCheckoutRepositoryOptions = {},
  ) {
    this.checkoutsTable = qualifiedTable(database, 'payment_checkouts');
    this.propertiesTable = qualifiedTable(database, 'properties');
    this.requestsTable = qualifiedTable(database, 'booking_requests');
    this.availabilityTable = qualifiedTable(database, 'availability_blocks');
    this.eventsTable = qualifiedTable(database, 'payment_provider_events');
    this.clock = options.clock ?? (() => new Date());
    this.checkoutDurationMs = options.checkoutDurationMs ?? CHECKOUT_DURATION_DEFAULT_MS;
    this.maxCheckoutAttempts = options.maxCheckoutAttempts ?? CHECKOUT_ATTEMPTS_DEFAULT;
    if (
      !Number.isSafeInteger(this.checkoutDurationMs) ||
      this.checkoutDurationMs < 1_000 ||
      this.checkoutDurationMs > CHECKOUT_DURATION_MAX_MS
    ) {
      throw new RangeError('payment checkout duration is outside the bounded range.');
    }
    if (
      !Number.isSafeInteger(this.maxCheckoutAttempts) ||
      this.maxCheckoutAttempts < 1 ||
      this.maxCheckoutAttempts > CHECKOUT_ATTEMPTS_MAX
    ) {
      throw new RangeError('payment checkout attempts are outside the bounded range.');
    }
  }

  async prepareCheckout(
    scope: PaymentOrganizationScope,
    propertyId: string,
    requestId: string,
    providerInput: PaymentProviderRegistration,
  ): Promise<PaymentCheckoutPreparation> {
    const organizationId = validateIdentifier(scope?.organizationId, 'organizationId');
    const property = validateIdentifier(propertyId, 'propertyId');
    const request = validateIdentifier(requestId, 'requestId');
    const provider = validateProvider(providerInput);
    const now = requireDateClock(this.clock);

    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requireProperty(transaction, this.propertiesTable, organizationId, property);
        const requestResult = await transaction.query<ApprovedRequestRow>(
          `
            SELECT organization_id, property_id, request_id, status, quote_json,
                   hold_record_id
            FROM ${this.requestsTable}
            WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
            FOR UPDATE
          `,
          [organizationId, property, request],
        );
        const requestRow = requestResult.rows[0];
        if (requestRow === undefined) {
          throw new PersistenceError('payment_request_not_found', 'booking request was not found.');
        }
        if (requestRow.status !== 'approved') {
          throw new PersistenceError(
            'payment_request_not_approved',
            'booking request is not approved for payment.',
          );
        }
        if (
          typeof requestRow.hold_record_id !== 'string' ||
          typeof requestRow.quote_json !== 'object' ||
          requestRow.quote_json === null
        ) {
          throw new PersistenceError(
            'database_corruption',
            'approved request payment fields are invalid.',
          );
        }
        const quote = createQuoteSnapshot(requestRow.quote_json);
        if (!quote.ok) {
          throw new PersistenceError(
            'database_corruption',
            'approved request quote is invalid.',
            quote.errors,
          );
        }
        const inventoryResult = await transaction.query<InventoryRow>(
          `
            SELECT block_kind, status
            FROM ${this.availabilityTable}
            WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
            FOR UPDATE
          `,
          [organizationId, property, requestRow.hold_record_id],
        );
        const inventory = inventoryResult.rows[0];
        if (
          inventory === undefined ||
          inventory.status !== 'active' ||
          inventory.block_kind !== 'occupancy'
        ) {
          throw new PersistenceError(
            'payment_occupancy_unavailable',
            'the approved occupancy record is no longer active.',
          );
        }

        const existingResult = await transaction.query<PaymentCheckoutRow>(
          `
            SELECT ${CHECKOUT_COLUMNS}
            FROM ${this.checkoutsTable}
            WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
              AND provider = $4 AND provider_account_id = $5
              AND state IN ('created', 'open')
              AND checkout_expires_at > $6
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
          `,
          [
            organizationId,
            property,
            request,
            provider.providerName,
            provider.providerAccountId,
            now,
          ],
        );
        const existing = existingResult.rows[0];
        if (existing !== undefined) {
          const mapped = mapCheckout(existing);
          const existingRequestResult = createPaymentCheckoutRequest({
            organizationId: mapped.organizationId,
            propertyId: mapped.propertyId,
            requestId: mapped.requestId,
            holdId: mapped.holdId,
            amountMinor: mapped.amountMinor,
            currency: mapped.currency,
            quoteRevision: mapped.quoteRevision,
            checkoutExpiresAt: mapped.checkoutExpiresAt,
          });
          if (!existingRequestResult.ok) {
            throw new PersistenceError(
              'database_corruption',
              'payment checkout request is invalid.',
            );
          }
          return {
            checkoutId: mapped.checkoutId,
            providerName: mapped.providerName,
            providerAccountId: mapped.providerAccountId,
            providerSessionId: mapped.providerSessionId,
            state: mapped.state as Extract<PaymentState, 'created' | 'open'>,
            request: existingRequestResult.value,
          };
        }

        const attemptsResult = await transaction.query<{ attempts: string }>(
          `
            SELECT count(*)::text AS attempts
            FROM ${this.checkoutsTable}
            WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
              AND provider = $4 AND provider_account_id = $5
          `,
          [organizationId, property, request, provider.providerName, provider.providerAccountId],
        );
        const attempts = Number(attemptsResult.rows[0]?.attempts ?? '0');
        if (!Number.isSafeInteger(attempts) || attempts >= this.maxCheckoutAttempts) {
          throw new PersistenceError(
            'payment_retry_exhausted',
            'payment checkout retry limit has been reached.',
          );
        }

        const expiresAt = new Date(now.getTime() + this.checkoutDurationMs);
        const checkoutRequestResult = createPaymentCheckoutRequest({
          organizationId,
          propertyId: property,
          requestId: request,
          holdId: requestRow.hold_record_id,
          amountMinor: quote.value.totalMinor,
          currency: quote.value.currency,
          quoteRevision: quoteRevision(quote.value),
          checkoutExpiresAt: expiresAt.toISOString(),
        });
        if (!checkoutRequestResult.ok) {
          throw new PersistenceError(
            'database_corruption',
            'server payment checkout request is invalid.',
          );
        }
        const checkoutId = randomUUID();
        await transaction.query(
          `
            INSERT INTO ${this.checkoutsTable} (
              checkout_id, organization_id, property_id, request_id, hold_record_id,
              provider, provider_account_id, amount_minor, currency, quote_revision,
              quote_json, state, checkout_expires_at, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                    'created', $12, $13, $13)
          `,
          [
            checkoutId,
            organizationId,
            property,
            request,
            requestRow.hold_record_id,
            provider.providerName,
            provider.providerAccountId,
            quote.value.totalMinor,
            quote.value.currency,
            checkoutRequestResult.value.quoteRevision,
            JSON.stringify(quote.value),
            expiresAt,
            now,
          ],
        );
        return {
          checkoutId,
          providerName: provider.providerName,
          providerAccountId: provider.providerAccountId,
          providerSessionId: null,
          state: 'created',
          request: checkoutRequestResult.value,
        };
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError('payment_event_duplicate', 'payment checkout already exists.');
      }
      throw error;
    }
  }

  async attachProviderSession(
    scope: PaymentOrganizationScope,
    propertyId: string,
    checkoutId: string,
    session: PaymentCheckoutSession,
  ): Promise<PaymentCheckoutRecord> {
    const organizationId = validateIdentifier(scope?.organizationId, 'organizationId');
    const property = validateIdentifier(propertyId, 'propertyId');
    const id = validateIdentifier(checkoutId, 'checkoutId');
    if (
      typeof session !== 'object' ||
      session === null ||
      typeof session.providerName !== 'string' ||
      !PROVIDER_PATTERN.test(session.providerName) ||
      typeof session.providerSessionId !== 'string' ||
      !SESSION_PATTERN.test(session.providerSessionId) ||
      typeof session.checkoutUrl !== 'string' ||
      session.checkoutUrl.length === 0 ||
      session.checkoutUrl.length > 2_048 ||
      !session.checkoutUrl.startsWith('https://') ||
      hasControlCharacters(session.checkoutUrl) ||
      typeof session.expiresAt !== 'string'
    ) {
      throw new PersistenceError('payment_validation', 'provider checkout session is invalid.');
    }
    const providerExpiry = timestamp(session.expiresAt, 'provider checkout expiry');
    const now = requireDateClock(this.clock);
    if (providerExpiry <= now) {
      throw new PersistenceError('payment_validation', 'provider checkout session is expired.');
    }

    try {
      return await this.database.withTransaction(async (transaction) => {
        await lockProperty(transaction, organizationId, property);
        await requireProperty(transaction, this.propertiesTable, organizationId, property);
        const result = await transaction.query<PaymentCheckoutRow>(
          `
            SELECT ${CHECKOUT_COLUMNS}
            FROM ${this.checkoutsTable}
            WHERE organization_id = $1 AND property_id = $2 AND checkout_id = $3
            FOR UPDATE
          `,
          [organizationId, property, id],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new PersistenceError(
            'payment_checkout_not_found',
            'payment checkout was not found.',
          );
        }
        const existing = mapCheckout(row);
        if (existing.providerName !== session.providerName) {
          throw new PersistenceError(
            'payment_provider_mismatch',
            'payment provider does not match.',
          );
        }
        if (existing.providerSessionId !== null) {
          if (existing.providerSessionId !== session.providerSessionId) {
            throw new PersistenceError(
              'payment_provider_mismatch',
              'payment checkout already has a different provider session.',
            );
          }
          return existing;
        }
        if (existing.state !== 'created' && existing.state !== 'open') {
          throw new PersistenceError('payment_event_rejected', 'payment checkout is not open.');
        }
        const checkoutExpiresAt = timestamp(existing.checkoutExpiresAt, 'checkout_expires_at');
        if (checkoutExpiresAt <= now || providerExpiry > checkoutExpiresAt) {
          throw new PersistenceError(
            'payment_validation',
            'provider checkout expiry exceeds the server bound.',
          );
        }
        const updated = await transaction.query<PaymentCheckoutRow>(
          `
            UPDATE ${this.checkoutsTable}
            SET provider_session_id = $4, state = 'open', updated_at = $5
            WHERE organization_id = $1 AND property_id = $2 AND checkout_id = $3
              AND provider_session_id IS NULL AND state = 'created'
            RETURNING ${CHECKOUT_COLUMNS}
          `,
          [organizationId, property, id, session.providerSessionId, now],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          throw new PersistenceError(
            'payment_event_rejected',
            'payment checkout attachment was not applied.',
          );
        }
        return mapCheckout(updatedRow);
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        throw error;
      }
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError(
          'payment_provider_mismatch',
          'provider session is already attached.',
        );
      }
      throw error;
    }
  }

  async processWebhookEvent(input: PaymentWebhookEvent): Promise<PaymentWebhookProcessingResult> {
    const event = validateWebhookEvent(input);
    const now = requireDateClock(this.clock);
    const hash = webhookEventHash(event);
    return this.database.withTransaction(async (transaction) => {
      const inserted = await transaction.query(
        `
          INSERT INTO ${this.eventsTable} (
            provider, provider_event_id, provider_account_id, event_type,
            provider_session_id, payload_hash, processing_status, rejection_code,
            received_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'rejected', 'processing', $7)
          ON CONFLICT (provider, provider_event_id) DO NOTHING
          RETURNING provider_event_id
        `,
        [
          event.providerName,
          event.providerEventId,
          event.providerAccountId,
          event.eventType,
          event.providerSessionId,
          hash,
          now,
        ],
      );
      if (inserted.rowCount === 0) {
        const previous = await transaction.query<PaymentProviderEventRow>(
          `
            SELECT payload_hash, provider_account_id, processing_status
            FROM ${this.eventsTable}
            WHERE provider = $1 AND provider_event_id = $2
          `,
          [event.providerName, event.providerEventId],
        );
        const previousRow = previous.rows[0];
        const duplicateCheckout = await this.loadCheckoutBySession(transaction, event);
        const duplicatePayment = duplicateCheckout === null ? null : mapCheckout(duplicateCheckout);
        if (
          previousRow === undefined ||
          previousRow.payload_hash !== hash ||
          previousRow.provider_account_id !== event.providerAccountId
        ) {
          return {
            status: 'rejected',
            payment: duplicatePayment,
            code: 'payment_event_duplicate',
          };
        }
        return { status: 'duplicate', payment: duplicatePayment };
      }

      await lockProperty(transaction, event.metadata.organizationId, event.metadata.propertyId);
      const checkoutRow = await this.loadCheckoutBySession(transaction, event);
      if (checkoutRow === null) {
        await this.markEvent(transaction, event, 'rejected', 'unknown_checkout', now);
        return { status: 'rejected', payment: null, code: 'unknown_checkout' };
      }
      let payment = mapCheckout(checkoutRow);
      const mismatchCode = this.paymentMismatchCode(payment, event);
      if (mismatchCode !== null) {
        await this.markEvent(transaction, event, 'rejected', mismatchCode, now);
        return { status: 'rejected', payment, code: mismatchCode };
      }

      const transition = paymentStateTransition(payment.state, event.eventType);
      if (
        !transition.ok ||
        payment.state === 'paid' ||
        payment.state === 'failed' ||
        payment.state === 'expired' ||
        payment.state === 'rejected'
      ) {
        const code = transition.ok ? 'terminal_state' : transition.error.code;
        await this.markEvent(transaction, event, 'ignored', code, now);
        return { status: 'ignored', payment, code };
      }
      if (payment.state !== 'open' && payment.state !== 'created') {
        await this.markEvent(transaction, event, 'rejected', 'invalid_state', now);
        return { status: 'rejected', payment, code: 'invalid_state' };
      }

      if (!(await this.hasApprovedActiveOccupancy(transaction, payment))) {
        await this.markEvent(transaction, event, 'ignored', 'occupancy_unavailable', now);
        return { status: 'ignored', payment, code: 'occupancy_unavailable' };
      }

      if (timestamp(payment.checkoutExpiresAt, 'checkout_expires_at') <= now) {
        payment = await this.updateCheckoutState(
          transaction,
          payment,
          'expired',
          'checkout_expired',
          null,
          now,
        );
        await this.markEvent(transaction, event, 'ignored', 'checkout_expired', now);
        return { status: 'ignored', payment, code: 'checkout_expired' };
      }

      payment = await this.updateCheckoutState(
        transaction,
        payment,
        transition.value,
        event.eventType === 'succeeded'
          ? null
          : event.eventType === 'expired'
            ? 'checkout_expired'
            : 'provider_payment_failed',
        event.providerPaymentId,
        now,
      );
      await this.markEvent(transaction, event, 'processed', null, now);
      return { status: 'processed', payment };
    });
  }

  async findCheckout(
    scope: PaymentOrganizationScope,
    propertyId: string,
    checkoutId: string,
  ): Promise<PaymentCheckoutRecord | null> {
    const organizationId = validateIdentifier(scope?.organizationId, 'organizationId');
    const property = validateIdentifier(propertyId, 'propertyId');
    const id = validateIdentifier(checkoutId, 'checkoutId');
    return this.database.withTransaction(async (transaction) => {
      await requireProperty(transaction, this.propertiesTable, organizationId, property);
      const result = await transaction.query<PaymentCheckoutRow>(
        `
          SELECT ${CHECKOUT_COLUMNS}
          FROM ${this.checkoutsTable}
          WHERE organization_id = $1 AND property_id = $2 AND checkout_id = $3
        `,
        [organizationId, property, id],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapCheckout(row);
    });
  }

  private async loadCheckoutBySession(
    transaction: PostgresTransactionPort,
    event: PaymentWebhookEvent,
  ): Promise<PaymentCheckoutRow | null> {
    const result = await transaction.query<PaymentCheckoutRow>(
      `
        SELECT ${CHECKOUT_COLUMNS}
        FROM ${this.checkoutsTable}
        WHERE provider = $1 AND provider_session_id = $2
        FOR UPDATE
      `,
      [event.providerName, event.providerSessionId],
    );
    return result.rows[0] ?? null;
  }

  private paymentMismatchCode(
    payment: PaymentCheckoutRecord,
    event: PaymentWebhookEvent,
  ): string | null {
    if (payment.providerAccountId !== event.providerAccountId) {
      return 'account_mismatch';
    }
    const metadata = event.metadata;
    if (
      payment.organizationId !== metadata.organizationId ||
      payment.propertyId !== metadata.propertyId ||
      payment.requestId !== metadata.requestId ||
      payment.holdId !== metadata.holdId
    ) {
      return 'metadata_mismatch';
    }
    if (payment.quoteRevision !== metadata.quoteRevision) {
      return 'quote_mismatch';
    }
    if (payment.amountMinor !== event.amountMinor) {
      return 'amount_mismatch';
    }
    if (payment.currency !== event.currency) {
      return 'currency_mismatch';
    }
    return null;
  }

  private async markEvent(
    transaction: PostgresTransactionPort,
    event: PaymentWebhookEvent,
    status: PaymentWebhookProcessingStatus,
    code: string | null,
    at: Date,
  ): Promise<void> {
    await transaction.query(
      `
        UPDATE ${this.eventsTable}
        SET processing_status = $3, rejection_code = $4, processed_at = $5
        WHERE provider = $1 AND provider_event_id = $2
      `,
      [event.providerName, event.providerEventId, status, code, at],
    );
  }

  private async hasApprovedActiveOccupancy(
    transaction: PostgresTransactionPort,
    payment: PaymentCheckoutRecord,
  ): Promise<boolean> {
    const requestResult = await transaction.query<{
      readonly status: unknown;
      readonly hold_record_id: unknown;
    }>(
      `
        SELECT status, hold_record_id
        FROM ${this.requestsTable}
        WHERE organization_id = $1 AND property_id = $2 AND request_id = $3
        FOR UPDATE
      `,
      [payment.organizationId, payment.propertyId, payment.requestId],
    );
    const request = requestResult.rows[0];
    if (request?.status !== 'approved' || request.hold_record_id !== payment.holdId) {
      return false;
    }
    const inventoryResult = await transaction.query<InventoryRow>(
      `
        SELECT block_kind, status
        FROM ${this.availabilityTable}
        WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        FOR UPDATE
      `,
      [payment.organizationId, payment.propertyId, payment.holdId],
    );
    const inventory = inventoryResult.rows[0];
    return inventory?.status === 'active' && inventory.block_kind === 'occupancy';
  }

  private async updateCheckoutState(
    transaction: PostgresTransactionPort,
    payment: PaymentCheckoutRecord,
    state: PaymentState,
    failureCode: string | null,
    providerPaymentId: string | null,
    at: Date,
  ): Promise<PaymentCheckoutRecord> {
    const result =
      state === 'paid'
        ? await transaction.query<PaymentCheckoutRow>(
            `
              UPDATE ${this.checkoutsTable}
              SET state = 'paid', failure_code = NULL, provider_payment_id = $4,
                  paid_at = $5, updated_at = $5
              WHERE organization_id = $1 AND property_id = $2 AND checkout_id = $3
              RETURNING ${CHECKOUT_COLUMNS}
            `,
            [payment.organizationId, payment.propertyId, payment.checkoutId, providerPaymentId, at],
          )
        : await transaction.query<PaymentCheckoutRow>(
            `
              UPDATE ${this.checkoutsTable}
              SET state = $4, failure_code = $5, paid_at = NULL, updated_at = $6
              WHERE organization_id = $1 AND property_id = $2 AND checkout_id = $3
              RETURNING ${CHECKOUT_COLUMNS}
            `,
            [
              payment.organizationId,
              payment.propertyId,
              payment.checkoutId,
              state,
              failureCode,
              at,
            ],
          );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceError('database_corruption', 'payment checkout update returned no row.');
    }
    return mapCheckout(row);
  }
}

export function createPostgresPaymentCheckoutRepository(
  database: PostgresDatabasePort,
  options?: PaymentCheckoutRepositoryOptions,
): PaymentCheckoutRepository {
  return new PostgresPaymentCheckoutRepository(database, options);
}
