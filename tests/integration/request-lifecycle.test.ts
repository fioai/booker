import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PropertyConfigurationInput,
  QuoteBreakdown,
} from '../../packages/booking-core/src/index.js';
import {
  createOrganizationRepository,
  createPostgresBookingOutboxRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createRateRepository,
  runMigrations,
  type BookingOutboxDeliveryEvent,
  type BookingRequestCreateInput,
  type BookingRequestRepository,
  OutboxDeliveryError,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:5432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `request_lifecycle_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;
const now = '2026-08-01T00:00:00.000Z';

function makeProperty(id: string): PropertyConfigurationInput {
  return {
    id,
    name: 'Lifecycle Test Bungalow',
    summary: 'A bounded lifecycle integration property.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'EUR',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: [{ type: 'queen', quantity: 1 }],
    bathroomCount: 1,
    maximumGuests: 2,
    amenities: ['garden'],
    hostNotes: 'Guest-visible note.',
    operationalNotes: 'Private owner note.',
  };
}

describe('PostgreSQL request-to-book lifecycle', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let repository: BookingRequestRepository;
  let organizationId: string;
  let otherOrganizationId: string;
  let propertyId: string;
  let rateQuote: QuoteBreakdown;
  let clockNow = now;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationId = `org-a-${testId}`;
    otherOrganizationId = `org-b-${testId}`;
    propertyId = `property-${testId}`;
    clockNow = now;
    const organizations = createOrganizationRepository(database as PostgresDatabasePort);
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    const rates = createRateRepository(database as PostgresDatabasePort);
    await organizations.create({ id: organizationId, name: 'Lifecycle Tenant A' });
    await organizations.create({ id: otherOrganizationId, name: 'Lifecycle Tenant B' });
    await properties.create({ organizationId }, makeProperty(propertyId));
    await rates.saveRatePlan({ organizationId }, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12500,
      cleaningFeeMinor: 3500,
      minimumStayNights: 2,
    });
    rateQuote = await rates.quote({ organizationId }, propertyId, {
      arrival: '2026-08-10',
      departure: '2026-08-12',
    });
    repository = createPostgresBookingRequestRepository(database as PostgresDatabasePort, {
      clock: () => new Date(clockNow),
    });
  });

  afterEach(async () => {
    await pool?.query(`DELETE FROM ${table('organizations')} WHERE id = ANY($1::text[])`, [
      [organizationId, otherOrganizationId],
    ]);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
    await pool?.end();
  });

  function input(
    id: string,
    overrides: Partial<BookingRequestCreateInput> = {},
  ): BookingRequestCreateInput {
    return {
      id,
      arrival: rateQuote.arrival,
      departure: rateQuote.departure,
      guestCount: 2,
      guestName: 'Ada Lovelace',
      guestEmail: 'ada@example.test',
      message: 'A quiet stay, please.',
      quote: rateQuote,
      ...overrides,
    };
  }

  function publicOptions(key: string) {
    return {
      idempotencyKey: key,
      deferInventory: true,
    };
  }

  it('persists many public pending requests without acquiring inventory', async () => {
    const requests = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.submit(
          { organizationId },
          propertyId,
          input(`public-pending-${runId}-${index}`),
          publicOptions(`public-pending-key-${index}`),
        ),
      ),
    );

    expect(requests).toHaveLength(20);
    expect(requests.every((request) => request.status === 'pending')).toBe(true);
    expect(requests.every((request) => request.holdRecordId === undefined)).toBe(true);
    const inventory = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE organization_id = $1 AND property_id = $2 AND record_id = ANY($3::text[])`,
      [organizationId, propertyId, requests.map((request) => request.id)],
    );
    expect(inventory?.rows[0]?.count).toBe('0');
    const outbox = await pool?.query<{ count: string; payloads: string }>(
      `SELECT count(*)::text AS count, string_agg(payload::text, '|') AS payloads FROM ${table('booking_outbox')}`,
    );
    expect(outbox?.rows[0]?.count).toBe('20');
    expect(outbox?.rows[0]?.payloads).not.toContain('ada@example.test');
    expect(outbox?.rows[0]?.payloads).not.toContain('Ada Lovelace');
  });

  it('lets exactly one concurrent owner approval acquire overlapping public inventory', async () => {
    const requests = await Promise.all([
      repository.submit(
        { organizationId },
        propertyId,
        input(`public-approve-a-${runId}`),
        publicOptions('public-approve-a-key'),
      ),
      repository.submit(
        { organizationId },
        propertyId,
        input(`public-approve-b-${runId}`),
        publicOptions('public-approve-b-key'),
      ),
    ]);
    const decisions = await Promise.allSettled(
      requests.map((request) => repository.approve({ organizationId }, propertyId, request.id)),
    );

    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(decisions.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(decisions.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'availability_conflict' },
    });
    const statuses = await pool?.query<{ status: string }>(
      `SELECT status FROM ${table('booking_requests')} ORDER BY request_id`,
    );
    expect(statuses?.rows.map((row) => row.status).sort()).toEqual(['approved', 'pending']);
    const occupancy = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE block_kind = 'occupancy' AND status = 'active'`,
    );
    expect(occupancy?.rows[0]?.count).toBe('1');
  });

  it.each(['ical', 'native'] as const)(
    'keeps a public request pending when an intervening %s block makes approval unavailable',
    async (blockKind) => {
      const submitted = await repository.submit(
        { organizationId },
        propertyId,
        input(`public-intervening-${blockKind}-${runId}`),
        publicOptions(`public-intervening-${blockKind}-key`),
      );
      if (blockKind === 'ical') {
        await pool?.query(
          `
            INSERT INTO ${table('ical_blocks')} (
              organization_id, property_id, source_id, external_uid,
              arrival, departure, status, event_status
            ) VALUES ($1, $2, $3, $4, $5::date, $6::date, 'active', 'confirmed')
          `,
          [
            organizationId,
            propertyId,
            `public-source-${runId}`,
            `public-event-${runId}`,
            submitted.arrival,
            submitted.departure,
          ],
        );
      } else {
        await pool?.query(
          `
            INSERT INTO ${table('availability_blocks')} (
              organization_id, property_id, record_id, block_kind, status, stay, reason
            ) VALUES ($1, $2, $3, 'manual', 'active', daterange($4::date, $5::date, '[)'), $6)
          `,
          [
            organizationId,
            propertyId,
            `public-manual-${runId}`,
            submitted.arrival,
            submitted.departure,
            'Owner block',
          ],
        );
      }

      await expect(
        repository.recheckAvailability({ organizationId }, propertyId, submitted.id),
      ).resolves.toMatchObject({ available: false, request: { status: 'pending' } });
      await expect(
        repository.approve({ organizationId }, propertyId, submitted.id),
      ).rejects.toMatchObject({ code: 'availability_conflict' });
      await expect(
        repository.find({ organizationId }, propertyId, submitted.id),
      ).resolves.toMatchObject({
        status: 'pending',
      });
      const requestInventory = await pool?.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE record_id = $1`,
        [submitted.id],
      );
      expect(requestInventory?.rows[0]?.count).toBe('0');
    },
  );

  it('expires a public pending request without releasing or creating inventory', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`public-expiry-${runId}`),
      publicOptions('public-expiry-key'),
    );
    const staleRepository = createPostgresBookingRequestRepository(
      database as PostgresDatabasePort,
      { clock: () => new Date('2026-08-01T00:16:00.000Z') },
    );
    await expect(
      staleRepository.approve({ organizationId }, propertyId, submitted.id),
    ).resolves.toMatchObject({ status: 'expired' });
    const inventory = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [submitted.id],
    );
    expect(inventory?.rows[0]?.count).toBe('0');
  });

  it('rejects a public pending request without releasing or creating inventory', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`public-reject-${runId}`),
      publicOptions('public-reject-key'),
    );
    const rejected = await repository.reject({ organizationId }, propertyId, submitted.id);

    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(rejected.holdRecordId).toBeUndefined();
    const inventory = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [submitted.id],
    );
    expect(inventory?.rows[0]?.count).toBe('0');
    const outbox = await pool?.query<{ event_type: string }>(
      `SELECT event_type FROM ${table('booking_outbox')} WHERE request_id = $1 ORDER BY event_type`,
      [submitted.id],
    );
    expect(outbox?.rows.map((row) => row.event_type)).toEqual([
      'booking_request.rejected',
      'booking_request.submitted',
    ]);
  });

  it('creates one immutable quote snapshot, expiring hold, and outbox event atomically', async () => {
    const saved = await repository.submit(
      { organizationId },
      propertyId,
      input(`request-${runId}`),
      { idempotencyKey: 'guest-retry-001' },
    );

    expect(saved).toMatchObject({
      id: `request-${runId}`,
      status: 'pending',
      quote: { totalMinor: 28500 },
    });
    expect(saved.holdExpiresAt).toBe('2026-08-01T00:15:00.000Z');
    expect(Object.isFrozen(saved.quote)).toBe(true);

    const requests = await pool?.query(`SELECT * FROM ${table('booking_requests')}`);
    const holds = await pool?.query(
      `SELECT * FROM ${table('availability_blocks')} WHERE block_kind = 'hold'`,
    );
    const outbox = await pool?.query(
      `SELECT event_type, status, attempts FROM ${table('booking_outbox')}`,
    );
    expect(requests?.rowCount).toBe(1);
    expect(holds?.rowCount).toBe(1);
    expect(outbox?.rows).toEqual([
      { event_type: 'booking_request.submitted', status: 'pending', attempts: 0 },
    ]);
    expect(JSON.stringify(outbox?.rows)).not.toContain('ada@example.test');
  });

  it('returns the original record for concurrent retries and rejects key reuse with a mismatch', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.submit({ organizationId }, propertyId, input(`retry-${runId}-${index}`), {
          idempotencyKey: 'same-key',
        }),
      ),
    );

    expect(new Set(results.map((result) => result.id))).toEqual(new Set([results[0]?.id]));
    await expect(
      repository.submit(
        { organizationId },
        propertyId,
        input(`different-${runId}`, { guestCount: 1 }),
        { idempotencyKey: 'same-key' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });

    const counts = await pool?.query<{ requests: string; holds: string; events: string }>(
      `
        SELECT
          (SELECT count(*) FROM ${table('booking_requests')})::text AS requests,
          (SELECT count(*) FROM ${table('availability_blocks')} WHERE block_kind = 'hold')::text AS holds,
          (SELECT count(*) FROM ${table('booking_outbox')})::text AS events
      `,
    );
    expect(counts?.rows[0]).toEqual({ requests: '1', holds: '1', events: '1' });
  });

  it('rejects idempotency reuse when the immutable quote snapshot changes', async () => {
    await repository.submit({ organizationId }, propertyId, input(`quote-key-${runId}`), {
      idempotencyKey: 'quote-key',
    });
    const changedQuote: QuoteBreakdown = {
      ...rateQuote,
      nightly: rateQuote.nightly.map((night) => ({ ...night, amountMinor: 13000 })),
      nightlySubtotalMinor: 26000,
      totalMinor: 29500,
    };

    await expect(
      repository.submit(
        { organizationId },
        propertyId,
        input(`quote-key-retry-${runId}`, { quote: changedQuote }),
        { idempotencyKey: 'quote-key' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
  });

  it('rejects malformed direct submissions with a bounded persistence error', async () => {
    await expect(
      repository.submit(
        { organizationId },
        propertyId,
        null as unknown as BookingRequestCreateInput,
        { idempotencyKey: 'malformed-request' },
      ),
    ).rejects.toMatchObject({ code: 'booking_request_validation' });

    await expect(
      repository.submit(
        { organizationId },
        propertyId,
        input(`malformed-options-${runId}`),
        null as unknown as string,
      ),
    ).rejects.toMatchObject({ code: 'booking_request_validation' });

    await expect(
      repository.submit({ organizationId }, propertyId, input(`malformed-defer-${runId}`), {
        idempotencyKey: 'malformed-defer',
        deferInventory: 'yes' as unknown as boolean,
      }),
    ).rejects.toMatchObject({ code: 'booking_request_validation' });
  });

  it('rejects reuse of a tenant idempotency key for a different property', async () => {
    const otherPropertyId = `other-property-${runId}`;
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    await properties.create({ organizationId }, makeProperty(otherPropertyId));
    await repository.submit({ organizationId }, propertyId, input(`tenant-key-${runId}`), {
      idempotencyKey: 'tenant-wide-key',
    });

    await expect(
      repository.submit(
        { organizationId },
        otherPropertyId,
        input(`other-property-request-${runId}`),
        { idempotencyKey: 'tenant-wide-key' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
    const counts = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('booking_requests')}`,
    );
    expect(counts?.rows[0]?.count).toBe('1');
  });

  it('classifies concurrent tenant-wide key reuse as an idempotency mismatch', async () => {
    const otherPropertyId = `concurrent-property-${runId}`;
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    await properties.create({ organizationId }, makeProperty(otherPropertyId));

    const results = await Promise.allSettled([
      repository.submit({ organizationId }, propertyId, input(`concurrent-a-${runId}`), {
        idempotencyKey: 'concurrent-tenant-key',
      }),
      repository.submit({ organizationId }, otherPropertyId, input(`concurrent-b-${runId}`), {
        idempotencyKey: 'concurrent-tenant-key',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'idempotency_key_reuse' },
    });
  });

  it('lets the PostgreSQL overlap boundary choose one winner and rolls back losers', async () => {
    const results = await Promise.allSettled([
      repository.submit({ organizationId }, propertyId, input(`race-a-${runId}`), {
        idempotencyKey: 'race-a',
      }),
      repository.submit({ organizationId }, propertyId, input(`race-b-${runId}`), {
        idempotencyKey: 'race-b',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'availability_conflict' },
    });
    const counts = await pool?.query<{ requests: string; holds: string; events: string }>(
      `
        SELECT
          (SELECT count(*) FROM ${table('booking_requests')})::text AS requests,
          (SELECT count(*) FROM ${table('availability_blocks')})::text AS holds,
          (SELECT count(*) FROM ${table('booking_outbox')})::text AS events
      `,
    );
    expect(counts?.rows[0]).toEqual({ requests: '1', holds: '1', events: '1' });
  });

  it('releases stale holds inside submission and never crosses tenant scope', async () => {
    const availability = await pool?.query(
      `
        INSERT INTO ${table('availability_blocks')} (
          organization_id, property_id, record_id, block_kind, status, stay, expires_at
        ) VALUES ($1, $2, $3, 'hold', 'active', daterange($4::date, $5::date, '[)'), $6)
      `,
      [
        organizationId,
        propertyId,
        `stale-${runId}`,
        rateQuote.arrival,
        rateQuote.departure,
        '2026-07-31T23:00:00.000Z',
      ],
    );
    expect(availability?.rowCount).toBe(1);

    await expect(
      repository.submit({ organizationId }, propertyId, input(`fresh-${runId}`), {
        idempotencyKey: 'fresh-key',
      }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(
      repository.submit(
        { organizationId: otherOrganizationId },
        propertyId,
        input(`wrong-${runId}`),
        { idempotencyKey: 'wrong-key' },
      ),
    ).rejects.toMatchObject({ code: 'property_not_found' });

    const stale = await pool?.query(
      `SELECT status FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [`stale-${runId}`],
    );
    expect(stale?.rows[0]?.status).toBe('released');
  });

  it('delivers durable outbox events through a deterministic delivery port with bounded retries', async () => {
    await repository.submit({ organizationId }, propertyId, input(`outbox-${runId}`), {
      idempotencyKey: 'outbox-key',
    });
    const outbox = createPostgresBookingOutboxRepository(database as PostgresDatabasePort, {
      clock: () => new Date(now),
    });
    const delivery = {
      deliver: vi.fn(async () => {
        throw new OutboxDeliveryError('temporary', 'deterministic test failure');
      }),
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(outbox.deliverPending(delivery, { limit: 1 })).resolves.toMatchObject({
        claimed: 1,
        delivered: 0,
        failed: attempt === 5 ? 1 : 0,
      });
    }
    await expect(outbox.deliverPending(delivery, { limit: 1 })).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      failed: 0,
    });
    expect(delivery.deliver).toHaveBeenCalledTimes(5);

    const row = await pool?.query(
      `SELECT status, attempts, last_error_code FROM ${table('booking_outbox')}`,
    );
    expect(row?.rows).toEqual([{ status: 'failed', attempts: 5, last_error_code: 'max_attempts' }]);
  });

  it('delivers a bounded outbox payload without guest contact or private request fields', async () => {
    await repository.submit({ organizationId }, propertyId, input(`outbox-success-${runId}`), {
      idempotencyKey: 'outbox-success-key',
    });
    const outbox = createPostgresBookingOutboxRepository(database as PostgresDatabasePort, {
      clock: () => new Date(now),
    });
    const delivered: BookingOutboxDeliveryEvent[] = [];

    await expect(
      outbox.deliverPending({
        deliver: vi.fn(async (event: BookingOutboxDeliveryEvent) => {
          delivered.push(event);
        }),
      }),
    ).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(delivered).toHaveLength(1);
    expect(Object.isFrozen(delivered[0])).toBe(true);
    expect(Object.isFrozen(delivered[0]?.payload)).toBe(true);
    expect(JSON.stringify(delivered[0]?.payload)).not.toContain('ada@example.test');
    expect(JSON.stringify(delivered[0]?.payload)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(delivered[0]?.payload)).not.toContain('A quiet stay');
    expect(delivered[0]?.eventType).toBe('booking_request.submitted');
  });

  it('moves an exhausted abandoned processing claim to a terminal bounded status', async () => {
    await repository.submit({ organizationId }, propertyId, input(`abandoned-${runId}`), {
      idempotencyKey: 'abandoned-key',
    });
    await pool?.query(
      `
        UPDATE ${table('booking_outbox')}
        SET status = 'processing', attempts = 5, locked_at = $1
      `,
      ['2026-07-31T00:00:00.000Z'],
    );
    const outbox = createPostgresBookingOutboxRepository(database as PostgresDatabasePort, {
      clock: () => new Date(now),
    });

    await expect(outbox.deliverPending({ deliver: vi.fn() }, { limit: 1 })).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      failed: 0,
    });
    const row = await pool?.query(`SELECT status, last_error_code FROM ${table('booking_outbox')}`);
    expect(row?.rows).toEqual([{ status: 'failed', last_error_code: 'max_attempts' }]);
  });

  it('approves by atomically rechecking and promoting the hold, and rejects illegal repeats', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`approve-${runId}`),
      { idempotencyKey: 'approve-key' },
    );

    await expect(
      repository.recheckAvailability({ organizationId }, propertyId, submitted.id),
    ).resolves.toEqual({
      request: expect.objectContaining({ id: submitted.id, status: 'pending' }),
      available: true,
    });
    const approved = await repository.approve({ organizationId }, propertyId, submitted.id);
    expect(approved).toMatchObject({ id: submitted.id, status: 'approved' });
    await expect(
      repository.reject({ organizationId }, propertyId, submitted.id),
    ).rejects.toMatchObject({
      code: 'invalid_booking_request_transition',
    });

    const hold = await pool?.query(
      `SELECT block_kind, status, expires_at FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [submitted.id],
    );
    expect(hold?.rows).toEqual([{ block_kind: 'occupancy', status: 'active', expires_at: null }]);
    const events = await pool?.query(
      `SELECT event_type FROM ${table('booking_outbox')} ORDER BY created_at, outbox_id`,
    );
    expect(events?.rows.map((row) => row.event_type)).toEqual([
      'booking_request.submitted',
      'booking_request.approved',
    ]);
  });

  it('rejects a pending request by releasing its hold and serializes approve/reject races', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`reject-${runId}`),
      { idempotencyKey: 'reject-key' },
    );
    const decisions = await Promise.allSettled([
      repository.approve({ organizationId }, propertyId, submitted.id),
      repository.reject({ organizationId }, propertyId, submitted.id),
    ]);
    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(decisions.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const final = await repository.find({ organizationId }, propertyId, submitted.id);
    expect(final?.status === 'approved' || final?.status === 'rejected').toBe(true);
    const events = await pool?.query<{ event_type: string }>(
      `SELECT event_type FROM ${table('booking_outbox')} ORDER BY created_at, outbox_id`,
    );
    expect(events?.rows).toHaveLength(2);
    const availability = await pool?.query<{ block_kind: string; status: string }>(
      `SELECT block_kind, status FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [submitted.id],
    );
    if (final?.status === 'approved') {
      expect(availability?.rows[0]).toEqual({ block_kind: 'occupancy', status: 'active' });
    } else {
      expect(availability?.rows[0]).toEqual({ block_kind: 'hold', status: 'released' });
    }
  });

  it('keeps approval side-effect free when an approval-time calendar recheck finds a conflict', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`calendar-race-${runId}`),
      { idempotencyKey: 'calendar-race-key' },
    );
    await pool?.query(
      `
        INSERT INTO ${table('ical_blocks')} (
          organization_id, property_id, source_id, external_uid,
          arrival, departure, status, event_status
        ) VALUES ($1, $2, $3, $4, $5::date, $6::date, 'active', 'confirmed')
      `,
      [
        organizationId,
        propertyId,
        `test-source-${runId}`,
        `event-${runId}`,
        submitted.arrival,
        submitted.departure,
      ],
    );

    await expect(
      repository.recheckAvailability({ organizationId }, propertyId, submitted.id),
    ).resolves.toMatchObject({ available: false, request: { status: 'pending' } });
    await expect(
      repository.approve({ organizationId }, propertyId, submitted.id),
    ).rejects.toMatchObject({
      code: 'availability_conflict',
    });
    const unchanged = await repository.find({ organizationId }, propertyId, submitted.id);
    expect(unchanged?.status).toBe('pending');
    const eventCount = await pool?.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table('booking_outbox')}`,
    );
    expect(eventCount?.rows[0]?.count).toBe('1');
    await pool?.query(
      `DELETE FROM ${table('ical_blocks')} WHERE organization_id = $1 AND property_id = $2`,
      [organizationId, propertyId],
    );
  });

  it('expires a stale pending request conservatively and keeps owner actions tenant-safe', async () => {
    const submitted = await repository.submit(
      { organizationId },
      propertyId,
      input(`stale-request-${runId}`),
      { idempotencyKey: 'stale-request-key' },
    );
    const staleRepository = createPostgresBookingRequestRepository(
      database as PostgresDatabasePort,
      {
        clock: () => new Date('2026-08-01T00:16:00.000Z'),
      },
    );
    await expect(
      staleRepository.approve({ organizationId }, propertyId, submitted.id),
    ).resolves.toMatchObject({
      status: 'expired',
    });
    await expect(
      staleRepository.approve({ organizationId: otherOrganizationId }, propertyId, submitted.id),
    ).rejects.toMatchObject({ code: 'property_not_found' });
    const hold = await pool?.query<{ status: string }>(
      `SELECT status FROM ${table('availability_blocks')} WHERE record_id = $1`,
      [submitted.id],
    );
    expect(hold?.rows[0]?.status).toBe('released');
    const events = await pool?.query<{ event_type: string }>(
      `SELECT event_type FROM ${table('booking_outbox')} ORDER BY created_at, outbox_id`,
    );
    expect(events?.rows.map((row) => row.event_type)).toEqual([
      'booking_request.submitted',
      'booking_request.expired',
    ]);
  });
});
