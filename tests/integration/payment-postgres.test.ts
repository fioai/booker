import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleBungalowFixture } from '../../packages/booking-core/test/property/fixtures.js';
import type { MoneyMinor, PaymentWebhookEvent } from '../../packages/payments/src/index.js';
import {
  createPostgresOrganizationRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPaymentCheckoutRepository,
  createPostgresPropertyRepository,
  createPostgresRateRepository,
  runMigrations,
  type PaymentCheckoutRepository,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `payment_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;

interface SeededPaymentCheckout {
  readonly payments: PaymentCheckoutRepository;
  readonly scope: { readonly organizationId: string };
  readonly propertyId: string;
  readonly requestId: string;
  readonly holdId: string;
  readonly prepared: Awaited<ReturnType<PaymentCheckoutRepository['prepareCheckout']>>;
  readonly session: {
    readonly providerName: 'stripe';
    readonly providerSessionId: string;
    readonly checkoutUrl: string;
    readonly expiresAt: string;
  };
}

async function seedAttachedCheckout(
  database: PostgresDatabasePort,
  label: string,
): Promise<SeededPaymentCheckout> {
  const organizationId = `org-${label}-${runId}`;
  const propertyId = `property-${label}-${runId}`;
  const requestId = `request-${label}-${runId}`;
  const scope = { organizationId };
  const organizations = createPostgresOrganizationRepository(database);
  const properties = createPostgresPropertyRepository(database);
  const rates = createPostgresRateRepository(database);
  const requests = createPostgresBookingRequestRepository(database, {
    clock: () => new Date('2026-08-01T00:00:00.000Z'),
  });
  const payments = createPostgresPaymentCheckoutRepository(database, {
    clock: () => new Date('2026-08-01T00:00:00.000Z'),
  });
  await organizations.create({ id: organizationId, name: `Payment ${label} Tenant` });
  await properties.create(scope, { ...sampleBungalowFixture, id: propertyId });
  await rates.saveRatePlan(scope, propertyId, {
    currency: 'EUR',
    baseNightlyRateMinor: 12_500,
    cleaningFeeMinor: 3_500,
    minimumStayNights: 2,
  });
  const quote = await rates.quote(scope, propertyId, {
    arrival: '2026-08-10',
    departure: '2026-08-12',
  });
  const submitted = await requests.submit(
    scope,
    propertyId,
    {
      id: requestId,
      arrival: '2026-08-10',
      departure: '2026-08-12',
      guestCount: 2,
      guestName: `${label} Guest`,
      guestEmail: `${label}@example.test`,
      message: null,
      quote,
    },
    { idempotencyKey: `${label}-key-${runId}` },
  );
  await requests.approve(scope, propertyId, submitted.id);
  const prepared = await payments.prepareCheckout(scope, propertyId, submitted.id, {
    providerName: 'stripe',
    providerAccountId: 'acct_test_001',
  });
  const session = {
    providerName: 'stripe' as const,
    providerSessionId: `cs_test_${label}_${runId}`,
    checkoutUrl: `https://checkout.stripe.test/cs_test_${label}_${runId}`,
    expiresAt: prepared.request.checkoutExpiresAt,
  };
  await payments.attachProviderSession(scope, propertyId, prepared.checkoutId, session);
  return {
    payments,
    scope,
    propertyId,
    requestId,
    holdId: submitted.id,
    prepared,
    session,
  };
}

function webhookFor(
  seeded: SeededPaymentCheckout,
  eventId: string,
  overrides: Partial<PaymentWebhookEvent> = {},
): PaymentWebhookEvent {
  return {
    providerName: 'stripe',
    providerEventId: eventId,
    providerAccountId: 'acct_test_001',
    eventType: 'succeeded',
    providerSessionId: seeded.session.providerSessionId,
    providerPaymentId: `pi_${eventId}`,
    amountMinor: 28_500 as MoneyMinor,
    currency: 'EUR',
    metadata: {
      organizationId: seeded.scope.organizationId,
      propertyId: seeded.propertyId,
      requestId: seeded.requestId,
      holdId: seeded.holdId,
      quoteRevision: seeded.prepared.request.quoteRevision,
    },
    occurredAt: '2026-08-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('payment checkout persistence against real PostgreSQL', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
    await pool?.end();
  });

  it('derives checkout amount, currency, tenant, request, approved occupancy, and quote revision', async () => {
    const db = database as PostgresDatabasePort;
    const organizationId = `org-${runId}`;
    const propertyId = `property-${runId}`;
    const requestId = `request-${runId}`;
    const scope = { organizationId };
    const organizations = createPostgresOrganizationRepository(db);
    const properties = createPostgresPropertyRepository(db);
    const rates = createPostgresRateRepository(db);
    const requests = createPostgresBookingRequestRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const payments = createPostgresPaymentCheckoutRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    await organizations.create({ id: organizationId, name: 'Payment Integration Tenant' });
    await properties.create(scope, { ...sampleBungalowFixture, id: propertyId });
    await rates.saveRatePlan(scope, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12_500,
      cleaningFeeMinor: 3_500,
      minimumStayNights: 2,
    });
    const quote = await rates.quote(scope, propertyId, {
      arrival: '2026-08-10',
      departure: '2026-08-12',
    });
    const request = await requests.submit(
      scope,
      propertyId,
      {
        id: requestId,
        arrival: '2026-08-10',
        departure: '2026-08-12',
        guestCount: 2,
        guestName: 'Payment Guest',
        guestEmail: 'payment@example.test',
        message: null,
        quote,
      },
      { idempotencyKey: `payment-key-${runId}` },
    );
    const approved = await requests.approve(scope, propertyId, request.id);
    expect(approved.status).toBe('approved');

    const prepared = await payments.prepareCheckout(scope, propertyId, request.id, {
      providerName: 'stripe',
      providerAccountId: 'acct_test_001',
    });

    expect(prepared).toMatchObject({
      state: 'created',
      providerSessionId: null,
      request: {
        organizationId,
        propertyId,
        requestId,
        holdId: request.id,
        amountMinor: 28_500,
        currency: 'EUR',
        checkoutExpiresAt: '2026-08-01T00:15:00.000Z',
      },
    });
    expect(prepared.request.quoteRevision).toMatch(/^[a-f0-9]{64}$/u);
    const checkoutCount = await (pool as Pool).query(
      `SELECT count(*)::text AS count FROM ${table('payment_checkouts')}`,
    );
    expect(checkoutCount.rows[0]).toEqual({
      count: '1',
    });
    const inventory = await (pool as Pool).query<{ block_kind: string; status: string }>(
      `SELECT block_kind, status FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [organizationId, propertyId, request.id],
    );
    expect(inventory.rows).toEqual([{ block_kind: 'occupancy', status: 'active' }]);
  });

  it('attaches a provider session transactionally and makes the same attachment idempotent', async () => {
    const db = database as PostgresDatabasePort;
    const organizationId = `org-attach-${runId}`;
    const propertyId = `property-attach-${runId}`;
    const requestId = `request-attach-${runId}`;
    const scope = { organizationId };
    const organizations = createPostgresOrganizationRepository(db);
    const properties = createPostgresPropertyRepository(db);
    const rates = createPostgresRateRepository(db);
    const requests = createPostgresBookingRequestRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const payments = createPostgresPaymentCheckoutRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });

    await organizations.create({ id: organizationId, name: 'Payment Attach Tenant' });
    await properties.create(scope, { ...sampleBungalowFixture, id: propertyId });
    await rates.saveRatePlan(scope, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12_500,
      cleaningFeeMinor: 3_500,
      minimumStayNights: 2,
    });
    const quote = await rates.quote(scope, propertyId, {
      arrival: '2026-08-10',
      departure: '2026-08-12',
    });
    const submitted = await requests.submit(
      scope,
      propertyId,
      {
        id: requestId,
        arrival: '2026-08-10',
        departure: '2026-08-12',
        guestCount: 2,
        guestName: 'Attach Guest',
        guestEmail: 'attach@example.test',
        message: null,
        quote,
      },
      { idempotencyKey: `attach-key-${runId}` },
    );
    await requests.approve(scope, propertyId, submitted.id);
    const prepared = await payments.prepareCheckout(scope, propertyId, submitted.id, {
      providerName: 'stripe',
      providerAccountId: 'acct_test_001',
    });
    const session = {
      providerName: 'stripe',
      providerSessionId: 'cs_test_attach_001',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_attach_001',
      expiresAt: prepared.request.checkoutExpiresAt,
    };

    const attached = await payments.attachProviderSession(
      scope,
      propertyId,
      prepared.checkoutId,
      session,
    );
    expect(attached).toMatchObject({
      checkoutId: prepared.checkoutId,
      providerSessionId: session.providerSessionId,
      state: 'open',
      amountMinor: 28_500,
      currency: 'EUR',
    });
    await expect(
      payments.attachProviderSession(scope, propertyId, prepared.checkoutId, session),
    ).resolves.toMatchObject({ state: 'open', providerSessionId: session.providerSessionId });
    await expect(
      payments.attachProviderSession(scope, propertyId, prepared.checkoutId, {
        ...session,
        providerName: 'other-provider',
      }),
    ).rejects.toMatchObject({ code: 'payment_provider_mismatch' });
  });

  it('persists a valid webhook event and safely ignores its duplicate', async () => {
    const db = database as PostgresDatabasePort;
    const organizationId = `org-event-${runId}`;
    const propertyId = `property-event-${runId}`;
    const requestId = `request-event-${runId}`;
    const scope = { organizationId };
    const organizations = createPostgresOrganizationRepository(db);
    const properties = createPostgresPropertyRepository(db);
    const rates = createPostgresRateRepository(db);
    const requests = createPostgresBookingRequestRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const payments = createPostgresPaymentCheckoutRepository(db, {
      clock: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    await organizations.create({ id: organizationId, name: 'Payment Event Tenant' });
    await properties.create(scope, { ...sampleBungalowFixture, id: propertyId });
    await rates.saveRatePlan(scope, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12_500,
      cleaningFeeMinor: 3_500,
      minimumStayNights: 2,
    });
    const quote = await rates.quote(scope, propertyId, {
      arrival: '2026-08-10',
      departure: '2026-08-12',
    });
    const submitted = await requests.submit(
      scope,
      propertyId,
      {
        id: requestId,
        arrival: '2026-08-10',
        departure: '2026-08-12',
        guestCount: 2,
        guestName: 'Webhook Guest',
        guestEmail: 'webhook@example.test',
        message: 'private message must not be returned',
        quote,
      },
      { idempotencyKey: `event-key-${runId}` },
    );
    await requests.approve(scope, propertyId, submitted.id);
    const prepared = await payments.prepareCheckout(scope, propertyId, submitted.id, {
      providerName: 'stripe',
      providerAccountId: 'acct_test_001',
    });
    const session = {
      providerName: 'stripe',
      providerSessionId: 'cs_test_event_001',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_event_001',
      expiresAt: prepared.request.checkoutExpiresAt,
    };
    await payments.attachProviderSession(scope, propertyId, prepared.checkoutId, session);
    const event: PaymentWebhookEvent = {
      providerName: 'stripe',
      providerEventId: 'evt_test_event_001',
      providerAccountId: 'acct_test_001',
      eventType: 'succeeded',
      providerSessionId: session.providerSessionId,
      providerPaymentId: 'pi_test_event_001',
      amountMinor: 28_500 as MoneyMinor,
      currency: 'EUR',
      metadata: {
        organizationId,
        propertyId,
        requestId,
        holdId: submitted.id,
        quoteRevision: prepared.request.quoteRevision,
      },
      occurredAt: '2026-08-01T00:00:01.000Z',
    };

    await expect(payments.processWebhookEvent(event)).resolves.toMatchObject({
      status: 'processed',
      payment: {
        state: 'paid',
        providerPaymentId: 'pi_test_event_001',
        amountMinor: 28_500,
        currency: 'EUR',
      },
    });
    await expect(payments.processWebhookEvent(event)).resolves.toMatchObject({
      status: 'duplicate',
      payment: { state: 'paid' },
    });
    const rows = await pool?.query<{ processing_status: string; count: string }>(
      `
        SELECT processing_status, count(*) OVER ()::text AS count
        FROM ${table('payment_provider_events')}
        WHERE provider_event_id = $1
      `,
      [event.providerEventId],
    );
    expect(rows?.rows).toEqual([{ processing_status: 'processed', count: '1' }]);
    const inventory = await pool?.query<{ block_kind: string; status: string }>(
      `SELECT block_kind, status FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [organizationId, propertyId, submitted.id],
    );
    expect(inventory?.rows).toEqual([{ block_kind: 'occupancy', status: 'active' }]);
    expect(
      JSON.stringify(await payments.findCheckout(scope, propertyId, prepared.checkoutId)),
    ).not.toContain('webhook@example.test');
  });

  it('rejects amount, currency, account, and metadata mismatches without changing open payment state', async () => {
    const seeded = await seedAttachedCheckout(database as PostgresDatabasePort, 'mismatch');
    const amountMismatch = webhookFor(seeded, 'evt_test_amount_mismatch', {
      amountMinor: 1 as MoneyMinor,
    });
    const currencyMismatch = webhookFor(seeded, 'evt_test_currency_mismatch', { currency: 'USD' });
    const accountMismatch = webhookFor(seeded, 'evt_test_account_mismatch', {
      providerAccountId: 'acct_other_001',
    });
    const metadataMismatch = webhookFor(seeded, 'evt_test_metadata_mismatch', {
      metadata: { ...amountMismatch.metadata, propertyId: 'other-property' },
    });

    await expect(seeded.payments.processWebhookEvent(amountMismatch)).resolves.toMatchObject({
      status: 'rejected',
      code: 'amount_mismatch',
      payment: { state: 'open' },
    });
    await expect(seeded.payments.processWebhookEvent(currencyMismatch)).resolves.toMatchObject({
      status: 'rejected',
      code: 'currency_mismatch',
      payment: { state: 'open' },
    });
    await expect(seeded.payments.processWebhookEvent(accountMismatch)).resolves.toMatchObject({
      status: 'rejected',
      code: 'account_mismatch',
      payment: { state: 'open' },
    });
    await expect(seeded.payments.processWebhookEvent(metadataMismatch)).resolves.toMatchObject({
      status: 'rejected',
      code: 'metadata_mismatch',
      payment: { state: 'open' },
    });
    await expect(
      seeded.payments.findCheckout(seeded.scope, seeded.propertyId, seeded.prepared.checkoutId),
    ).resolves.toMatchObject({ state: 'open' });
  });

  it('records failed and expired events without changing the approved occupancy', async () => {
    const failed = await seedAttachedCheckout(database as PostgresDatabasePort, 'ordering');
    const failure = webhookFor(failed, 'evt_test_failure_first', {
      eventType: 'failed',
      providerPaymentId: null,
    });
    await expect(failed.payments.processWebhookEvent(failure)).resolves.toMatchObject({
      status: 'processed',
      payment: { state: 'failed' },
    });
    const failedInventory = await pool?.query<{ block_kind: string; status: string }>(
      `SELECT block_kind, status FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [failed.scope.organizationId, failed.propertyId, failed.holdId],
    );
    expect(failedInventory?.rows).toEqual([{ block_kind: 'occupancy', status: 'active' }]);
    await expect(
      failed.payments.processWebhookEvent(webhookFor(failed, 'evt_test_success_after_failure')),
    ).resolves.toMatchObject({
      status: 'ignored',
      code: 'terminal_state',
      payment: { state: 'failed' },
    });

    const expired = await seedAttachedCheckout(database as PostgresDatabasePort, 'expired');
    await expect(
      expired.payments.processWebhookEvent(
        webhookFor(expired, 'evt_test_checkout_expired', {
          eventType: 'expired',
          providerPaymentId: null,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'processed',
      payment: { state: 'expired' },
    });
    const expiredInventory = await pool?.query<{ status: string; block_kind: string }>(
      `SELECT status, block_kind FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [expired.scope.organizationId, expired.propertyId, expired.holdId],
    );
    expect(expiredInventory?.rows).toEqual([{ status: 'active', block_kind: 'occupancy' }]);
  });

  it('fails closed for missing, released, and non-occupancy inventory without changing payment or inventory', async () => {
    const released = await seedAttachedCheckout(database as PostgresDatabasePort, 'released');
    await pool?.query(
      `UPDATE ${table('availability_blocks')} SET status = 'released', released_at = CURRENT_TIMESTAMP WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [released.scope.organizationId, released.propertyId, released.holdId],
    );
    await expect(
      released.payments.prepareCheckout(released.scope, released.propertyId, released.requestId, {
        providerName: 'stripe',
        providerAccountId: 'acct_test_001',
      }),
    ).rejects.toMatchObject({ code: 'payment_occupancy_unavailable' });
    await expect(
      released.payments.processWebhookEvent(webhookFor(released, 'evt_test_released_success')),
    ).resolves.toMatchObject({
      status: 'ignored',
      code: 'occupancy_unavailable',
      payment: { state: 'open' },
    });
    await expect(
      released.payments.findCheckout(
        released.scope,
        released.propertyId,
        released.prepared.checkoutId,
      ),
    ).resolves.toMatchObject({ state: 'open' });
    const releasedInventory = await pool?.query<{ status: string; block_kind: string }>(
      `SELECT status, block_kind FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [released.scope.organizationId, released.propertyId, released.holdId],
    );
    expect(releasedInventory?.rows).toEqual([{ status: 'released', block_kind: 'occupancy' }]);

    const nonOccupancy = await seedAttachedCheckout(database as PostgresDatabasePort, 'manual');
    await pool?.query(
      `UPDATE ${table('availability_blocks')} SET block_kind = 'manual' WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [nonOccupancy.scope.organizationId, nonOccupancy.propertyId, nonOccupancy.holdId],
    );
    await expect(
      nonOccupancy.payments.prepareCheckout(
        nonOccupancy.scope,
        nonOccupancy.propertyId,
        nonOccupancy.requestId,
        { providerName: 'stripe', providerAccountId: 'acct_test_001' },
      ),
    ).rejects.toMatchObject({ code: 'payment_occupancy_unavailable' });
    await expect(
      nonOccupancy.payments.processWebhookEvent(
        webhookFor(nonOccupancy, 'evt_test_manual_success'),
      ),
    ).resolves.toMatchObject({
      status: 'ignored',
      code: 'occupancy_unavailable',
      payment: { state: 'open' },
    });
    const manualInventory = await pool?.query<{ status: string; block_kind: string }>(
      `SELECT status, block_kind FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [nonOccupancy.scope.organizationId, nonOccupancy.propertyId, nonOccupancy.holdId],
    );
    expect(manualInventory?.rows).toEqual([{ status: 'active', block_kind: 'manual' }]);

    const missing = await seedAttachedCheckout(database as PostgresDatabasePort, 'missing');
    await pool?.query(
      `DELETE FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [missing.scope.organizationId, missing.propertyId, missing.holdId],
    );
    await expect(
      missing.payments.prepareCheckout(missing.scope, missing.propertyId, missing.requestId, {
        providerName: 'stripe',
        providerAccountId: 'acct_test_001',
      }),
    ).rejects.toMatchObject({ code: 'payment_occupancy_unavailable' });
    await expect(
      missing.payments.processWebhookEvent(webhookFor(missing, 'evt_test_missing_success')),
    ).resolves.toMatchObject({ status: 'rejected', code: 'unknown_checkout', payment: null });
    const missingInventory = await pool?.query(
      `SELECT 1 FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = $3`,
      [missing.scope.organizationId, missing.propertyId, missing.holdId],
    );
    expect(missingInventory?.rowCount).toBe(0);
  });
});
