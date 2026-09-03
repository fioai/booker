import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PropertyConfigurationInput,
  QuoteBreakdown,
} from '../../packages/booking-core/src/index.js';
import {
  createPostgresOrganizationRepository,
  createPostgresBookingOutboxRepository,
  createPostgresBookingRequestRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createPostgresRateRepository,
  runMigrations,
  type BookingOutboxDeliveryEvent,
  type BookingRequestCreateInput,
  type BookingRequestRepository,
  OutboxDeliveryError,
  type PostgresDatabasePort,
} from '../../packages/database-postgres/src/index.js';
import {
  MIGRATION_FILES,
  runMigrationsFromDirectory,
} from '../../packages/database-postgres/src/database/migrations.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
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
    const organizations = createPostgresOrganizationRepository(database as PostgresDatabasePort);
    const properties = createPostgresPropertyRepository(database as PostgresDatabasePort);
    const rates = createPostgresRateRepository(database as PostgresDatabasePort);
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

  it('counts persisted Unicode text by code point and keeps retry fingerprints stable', async () => {
    const astralCodePoint = '😀';
    const exactBoundaries = {
      guestName: astralCodePoint.repeat(120),
      guestEmail: `${astralCodePoint.repeat(241)}@example.test`,
      message: astralCodePoint.repeat(2_000),
    };
    const idempotencyKey = `unicode-boundary-key-${runId}`;
    const first = await repository.submit(
      { organizationId },
      propertyId,
      input(`unicode-boundary-${runId}`, exactBoundaries),
      publicOptions(idempotencyKey),
    );

    expect(first.guestName).toBe(exactBoundaries.guestName);
    expect(first.guestEmail).toBe(exactBoundaries.guestEmail);
    expect(first.message).toBe(exactBoundaries.message);
    expect(first.requestFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const retry = await repository.submit(
      { organizationId },
      propertyId,
      input(`unicode-boundary-retry-${runId}`, exactBoundaries),
      publicOptions(idempotencyKey),
    );
    expect(retry.id).toBe(first.id);
    expect(retry.requestFingerprint).toBe(first.requestFingerprint);

    await expect(
      repository.submit(
        { organizationId },
        propertyId,
        input(`unicode-boundary-mismatch-${runId}`, {
          ...exactBoundaries,
          message: `${astralCodePoint.repeat(1_999)}🚀`,
        }),
        publicOptions(idempotencyKey),
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });

    const maximumPlusOneInputs: readonly Partial<BookingRequestCreateInput>[] = [
      { guestName: astralCodePoint.repeat(121) },
      { guestEmail: `${astralCodePoint.repeat(242)}@example.test` },
      { message: astralCodePoint.repeat(2_001) },
    ];
    for (const [index, overrides] of maximumPlusOneInputs.entries()) {
      await expect(
        repository.submit(
          { organizationId },
          propertyId,
          input(`unicode-over-limit-${index}-${runId}`, overrides),
          publicOptions(`unicode-over-limit-key-${index}-${runId}`),
        ),
      ).rejects.toMatchObject({ code: 'booking_request_validation' });
    }

    const persisted = await pool?.query<{
      request_count: number;
      request_fingerprint: string;
      guest_name_length: number;
      guest_email_length: number;
      message_length: number;
    }>(
      `
        SELECT
          (
            SELECT count(*)::integer
            FROM ${table('booking_requests')}
            WHERE organization_id = $1
          ) AS request_count,
          request_fingerprint,
          char_length(guest_name)::integer AS guest_name_length,
          char_length(guest_email)::integer AS guest_email_length,
          char_length(message)::integer AS message_length
        FROM ${table('booking_requests')}
        WHERE organization_id = $1 AND idempotency_key = $2
      `,
      [organizationId, idempotencyKey],
    );
    expect(persisted?.rows).toEqual([
      {
        request_count: 1,
        request_fingerprint: first.requestFingerprint,
        guest_name_length: 120,
        guest_email_length: 254,
        message_length: 2_000,
      },
    ]);
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

  it.each([
    ['arrival', '2026-08-11'],
    ['departure', '2026-08-13'],
  ] as const)(
    'classifies a request row with a mismatched %s quote date as database corruption',
    async (dateColumn, changedDate) => {
      const saved = await repository.submit(
        { organizationId },
        propertyId,
        input(`corrupt-${dateColumn}-${runId}`),
        { idempotencyKey: `corrupt-${dateColumn}-key-${runId}` },
      );
      await pool?.query(
        `UPDATE ${table('booking_requests')} SET ${dateColumn} = $2::date WHERE request_id = $1`,
        [saved.id, changedDate],
      );

      await expect(repository.find({ organizationId }, propertyId, saved.id)).rejects.toMatchObject(
        {
          code: 'database_corruption',
        },
      );
    },
  );

  it('baselines checksums and scopes pending legacy hold repair during the 009 to 012 upgrade', async () => {
    const upgradeSchema = `request_lifecycle_upgrade_test_${runId}`;
    const upgradeTable = (name: string): string => `"${upgradeSchema}"."${name}"`;
    const temporaryMigrationDirectory = await mkdtemp(
      join(tmpdir(), `booking-engine-migrations-${runId}-`),
    );
    const authoritativeMigrationDirectory = new URL(
      '../../packages/database-postgres/migrations/',
      import.meta.url,
    );
    let upgradeDatabase: PostgresDatabasePort | undefined;

    try {
      upgradeDatabase = createPostgresDatabase({
        connectionString,
        schema: upgradeSchema,
      });
      const migrationFilesThrough009 = MIGRATION_FILES.slice(0, 9);
      await Promise.all(
        MIGRATION_FILES.map((migrationFile) =>
          copyFile(
            new URL(migrationFile, authoritativeMigrationDirectory),
            join(temporaryMigrationDirectory, migrationFile),
          ),
        ),
      );
      await runMigrationsFromDirectory(
        upgradeDatabase,
        temporaryMigrationDirectory,
        migrationFilesThrough009,
      );
      await pool?.query(`ALTER TABLE ${upgradeTable('schema_migrations')} DROP COLUMN checksum`);

      const upgradeOrganizations = createPostgresOrganizationRepository(upgradeDatabase);
      const upgradeProperties = createPostgresPropertyRepository(upgradeDatabase);
      const upgradeRates = createPostgresRateRepository(upgradeDatabase);
      const sameOrganizationForeignPropertyId = `foreign-property-${runId}`;
      await upgradeOrganizations.create({ id: organizationId, name: 'Lifecycle Upgrade Tenant' });
      await upgradeOrganizations.create({
        id: otherOrganizationId,
        name: 'Foreign Lifecycle Upgrade Tenant',
      });
      await upgradeProperties.create({ organizationId }, makeProperty(propertyId));
      await upgradeProperties.create(
        { organizationId },
        makeProperty(sameOrganizationForeignPropertyId),
      );
      await upgradeProperties.create(
        { organizationId: otherOrganizationId },
        makeProperty(propertyId),
      );
      await upgradeRates.saveRatePlan({ organizationId }, propertyId, {
        currency: 'EUR',
        baseNightlyRateMinor: 12500,
        cleaningFeeMinor: 3500,
        minimumStayNights: 2,
      });
      const upgradeQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-10',
        departure: '2026-08-12',
      });
      const dateMismatchRequestQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-14',
        departure: '2026-08-16',
      });
      const dateMismatchHoldQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-16',
        departure: '2026-08-18',
      });
      const activeHoldQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-20',
        departure: '2026-08-22',
      });
      const releasedHoldQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-24',
        departure: '2026-08-26',
      });
      const nonHoldQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-08-28',
        departure: '2026-08-30',
      });
      const approvedOccupancyQuote = await upgradeRates.quote({ organizationId }, propertyId, {
        arrival: '2026-09-01',
        departure: '2026-09-03',
      });
      const upgradeInput = (
        id: string,
        overrides: Partial<BookingRequestCreateInput> = {},
      ): BookingRequestCreateInput => ({
        id,
        arrival: upgradeQuote.arrival,
        departure: upgradeQuote.departure,
        guestCount: 2,
        guestName: 'Ada Lovelace',
        guestEmail: 'ada@example.test',
        message: 'A quiet stay, please.',
        quote: upgradeQuote,
        ...overrides,
      });
      const insertLegacyRequest = async (
        requestId: string,
        idempotencyKey: string,
        holdRecordId: string | null,
        holdExpiresAt: string,
        quote: QuoteBreakdown,
        status: 'approved' | 'pending' = 'pending',
      ): Promise<void> => {
        const requestFingerprint = createHash('md5').update(requestId).digest('hex');
        await pool?.query(
          `
            INSERT INTO ${upgradeTable('booking_requests')} (
              organization_id, property_id, request_id, arrival, departure,
              guest_count, guest_name, guest_email, message, status, quote_json,
              idempotency_key, request_fingerprint,
              hold_record_id, hold_expires_at, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11::jsonb,
              $12, $13, $14, $15, $16, $16
            )
          `,
          [
            organizationId,
            propertyId,
            requestId,
            quote.arrival,
            quote.departure,
            2,
            'Ada Lovelace',
            'ada@example.test',
            'A quiet stay, please.',
            status,
            JSON.stringify(quote),
            idempotencyKey,
            requestFingerprint,
            holdRecordId,
            holdExpiresAt,
            now,
          ],
        );
      };
      const legacyRequestId = `legacy-${runId}`;
      const legacyKey = `legacy-key-${runId}`;
      const phantomHoldRecordId = `phantom-hold-${runId}`;
      const activeHoldRequestId = `active-legacy-${runId}`;
      const activeHoldRecordId = `active-hold-${runId}`;
      const activeHoldExpiresAt = '2026-08-01T00:30:00.000Z';
      const dateMismatchRequestId = `date-mismatch-legacy-${runId}`;
      const dateMismatchHoldRecordId = `date-mismatch-hold-${runId}`;
      const dateMismatchHoldExpiresAt = '2026-08-01T00:40:00.000Z';
      const releasedHoldRequestId = `released-legacy-${runId}`;
      const releasedHoldRecordId = `released-hold-${runId}`;
      const releasedHoldExpiresAt = '2026-08-01T00:20:00.000Z';
      const nonHoldRequestId = `non-hold-legacy-${runId}`;
      const nonHoldRecordId = `non-hold-${runId}`;
      const foreignHoldExpiresAt = '2026-08-01T00:45:00.000Z';
      const approvedRequestId = `approved-legacy-${runId}`;
      const approvedHoldExpiresAt = '2026-08-01T00:35:00.000Z';
      const publicPendingRequestId = `public-pending-${runId}`;
      const publicPendingExpiresAt = '2026-08-01T00:50:00.000Z';
      await insertLegacyRequest(
        legacyRequestId,
        legacyKey,
        phantomHoldRecordId,
        '2026-08-01T00:15:00.000Z',
        upgradeQuote,
      );
      await insertLegacyRequest(
        activeHoldRequestId,
        `active-legacy-key-${runId}`,
        activeHoldRecordId,
        activeHoldExpiresAt,
        activeHoldQuote,
      );
      await insertLegacyRequest(
        dateMismatchRequestId,
        `date-mismatch-legacy-key-${runId}`,
        dateMismatchHoldRecordId,
        dateMismatchHoldExpiresAt,
        dateMismatchRequestQuote,
      );
      await insertLegacyRequest(
        releasedHoldRequestId,
        `released-legacy-key-${runId}`,
        releasedHoldRecordId,
        releasedHoldExpiresAt,
        releasedHoldQuote,
      );
      await insertLegacyRequest(
        nonHoldRequestId,
        `non-hold-legacy-key-${runId}`,
        nonHoldRecordId,
        '2026-08-01T00:25:00.000Z',
        nonHoldQuote,
      );
      await insertLegacyRequest(
        publicPendingRequestId,
        `public-pending-key-${runId}`,
        null,
        publicPendingExpiresAt,
        upgradeQuote,
      );
      await insertLegacyRequest(
        approvedRequestId,
        `approved-legacy-key-${runId}`,
        approvedRequestId,
        approvedHoldExpiresAt,
        approvedOccupancyQuote,
        'approved',
      );
      await pool?.query(
        `
          INSERT INTO ${upgradeTable('availability_blocks')} (
            organization_id, property_id, record_id, block_kind, status, stay, expires_at
          )
          VALUES
            ($1, $2, $3, 'hold', 'active', daterange($4::date, $5::date, '[)'), $6),
            ($1, $2, $7, 'hold', 'released', daterange($8::date, $9::date, '[)'), $10),
            ($1, $2, $11, 'manual', 'active', daterange($12::date, $13::date, '[)'), NULL),
            ($1, $2, $14, 'occupancy', 'active', daterange($15::date, $16::date, '[)'), NULL),
            ($1, $17, $18, 'hold', 'active', daterange($19::date, $20::date, '[)'), $21),
            ($22, $2, $18, 'hold', 'active', daterange($19::date, $20::date, '[)'), $21),
            ($1, $2, $23, 'hold', 'active', daterange($24::date, $25::date, '[)'), $26)
        `,
        [
          organizationId,
          propertyId,
          activeHoldRecordId,
          activeHoldQuote.arrival,
          activeHoldQuote.departure,
          activeHoldExpiresAt,
          releasedHoldRecordId,
          releasedHoldQuote.arrival,
          releasedHoldQuote.departure,
          releasedHoldExpiresAt,
          nonHoldRecordId,
          nonHoldQuote.arrival,
          nonHoldQuote.departure,
          approvedRequestId,
          approvedOccupancyQuote.arrival,
          approvedOccupancyQuote.departure,
          sameOrganizationForeignPropertyId,
          phantomHoldRecordId,
          upgradeQuote.arrival,
          upgradeQuote.departure,
          foreignHoldExpiresAt,
          otherOrganizationId,
          dateMismatchHoldRecordId,
          dateMismatchHoldQuote.arrival,
          dateMismatchHoldQuote.departure,
          dateMismatchHoldExpiresAt,
        ],
      );

      const stagedMigrations = await pool?.query<{ id: string }>(
        `SELECT id FROM ${upgradeTable('schema_migrations')} ORDER BY id`,
      );
      expect(stagedMigrations?.rows.map(({ id }) => id)).toEqual(migrationFilesThrough009);
      const stagedRequest = await pool?.query<{
        hold_expires_at: Date | null;
        hold_record_id: string | null;
      }>(
        `
          SELECT hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = $1
        `,
        [legacyRequestId],
      );
      expect(stagedRequest?.rows[0]?.hold_record_id).toBe(phantomHoldRecordId);
      expect(stagedRequest?.rows[0]?.hold_expires_at).not.toBeNull();
      const stagedDateMismatchRequest = await pool?.query<{
        hold_expires_at: Date | null;
        hold_record_id: string | null;
      }>(
        `
          SELECT hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = $1
        `,
        [dateMismatchRequestId],
      );
      expect(stagedDateMismatchRequest?.rows[0]).toEqual({
        hold_expires_at: new Date(dateMismatchHoldExpiresAt),
        hold_record_id: dateMismatchHoldRecordId,
      });
      const inventoryRecordIds = [
        activeHoldRecordId,
        dateMismatchHoldRecordId,
        approvedRequestId,
        releasedHoldRecordId,
        nonHoldRecordId,
        phantomHoldRecordId,
      ];
      const readInventoryControls = async () =>
        (
          await pool?.query<{
            arrival: string;
            block_kind: string;
            departure: string;
            expires_at: Date | null;
            organization_id: string;
            property_id: string;
            record_id: string;
            status: string;
          }>(
            `
              SELECT
                organization_id,
                property_id,
                record_id,
                block_kind,
                status,
                lower(stay)::text AS arrival,
                upper(stay)::text AS departure,
                expires_at
              FROM ${upgradeTable('availability_blocks')}
              WHERE record_id = ANY($1::text[])
              ORDER BY organization_id, property_id, record_id
            `,
            [inventoryRecordIds],
          )
        )?.rows;
      const inventoryBeforeMigration = await readInventoryControls();
      expect(inventoryBeforeMigration).toHaveLength(7);
      expect(
        inventoryBeforeMigration
          ?.filter(({ record_id }) => record_id === phantomHoldRecordId)
          .map(({ organization_id, property_id }) => ({ organization_id, property_id })),
      ).toEqual([
        {
          organization_id: organizationId,
          property_id: sameOrganizationForeignPropertyId,
        },
        {
          organization_id: otherOrganizationId,
          property_id: propertyId,
        },
      ]);

      const migrationStatuses = await runMigrations(upgradeDatabase);
      expect(migrationStatuses.at(-1)).toEqual({
        id: '012_request_hold_stay_repair.sql',
        checksum: '9edeca83ec512db42bcf03a54b02c35ccc57bb7e2c86daaea8d6d68cfe62030a',
      });

      const expectedBaselines = await Promise.all(
        migrationFilesThrough009.map(async (id) => ({
          id,
          checksum: createHash('sha256')
            .update(await readFile(new URL(id, authoritativeMigrationDirectory)))
            .digest('hex'),
        })),
      );
      const baselinedMigrations = await pool?.query<{
        checksum: string | null;
        id: string;
      }>(
        `
          SELECT id, checksum
          FROM ${upgradeTable('schema_migrations')}
          WHERE id = ANY($1::text[])
          ORDER BY id
        `,
        [migrationFilesThrough009],
      );
      expect(baselinedMigrations?.rows).toEqual(expectedBaselines);
      const checksumColumn = await pool?.query<{ is_nullable: 'NO' | 'YES' }>(
        `
          SELECT is_nullable
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = 'schema_migrations'
            AND column_name = 'checksum'
        `,
        [upgradeSchema],
      );
      expect(checksumColumn?.rows[0]).toEqual({ is_nullable: 'NO' });
      await expect(
        pool?.query(
          `UPDATE ${upgradeTable('schema_migrations')} SET checksum = NULL WHERE id = $1`,
          [migrationFilesThrough009[0]],
        ),
      ).rejects.toMatchObject({ code: '23502' });

      const clearedRequestIds = [
        dateMismatchRequestId,
        legacyRequestId,
        releasedHoldRequestId,
        nonHoldRequestId,
      ].sort();
      const repairedRequests = await pool?.query<{
        fingerprint_version: string;
        hold_expires_at: Date | null;
        hold_record_id: string | null;
        request_id: string;
      }>(
        `
          SELECT request_id, fingerprint_version, hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = ANY($1::text[])
          ORDER BY request_id
        `,
        [clearedRequestIds],
      );
      expect(repairedRequests?.rows).toEqual(
        clearedRequestIds.map((request_id) => ({
          fingerprint_version: 'legacy-md5-request-id',
          hold_expires_at: null,
          hold_record_id: null,
          request_id,
        })),
      );
      const preservedRequest = await pool?.query<{
        fingerprint_version: string;
        hold_expires_at: Date | null;
        hold_record_id: string | null;
      }>(
        `
          SELECT fingerprint_version, hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = $1
        `,
        [activeHoldRequestId],
      );
      expect(preservedRequest?.rows[0]).toEqual({
        fingerprint_version: 'legacy-md5-request-id',
        hold_expires_at: new Date(activeHoldExpiresAt),
        hold_record_id: activeHoldRecordId,
      });
      const preservedPublicPendingRequest = await pool?.query<{
        hold_expires_at: Date | null;
        hold_record_id: string | null;
        status: string;
      }>(
        `
          SELECT status, hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = $1
        `,
        [publicPendingRequestId],
      );
      expect(preservedPublicPendingRequest?.rows[0]).toEqual({
        hold_expires_at: new Date(publicPendingExpiresAt),
        hold_record_id: null,
        status: 'pending',
      });
      const preservedTerminalRequest = await pool?.query<{
        hold_expires_at: Date | null;
        hold_record_id: string | null;
        status: string;
      }>(
        `
          SELECT status, hold_record_id, hold_expires_at
          FROM ${upgradeTable('booking_requests')}
          WHERE request_id = $1
        `,
        [approvedRequestId],
      );
      expect(preservedTerminalRequest?.rows[0]).toEqual({
        hold_expires_at: new Date(approvedHoldExpiresAt),
        hold_record_id: approvedRequestId,
        status: 'approved',
      });
      expect(await readInventoryControls()).toEqual(inventoryBeforeMigration);
      const repairMigrations = await pool?.query<{ checksum: string; id: string }>(
        `
          SELECT id, checksum
          FROM ${upgradeTable('schema_migrations')}
          WHERE id = ANY($1::text[])
          ORDER BY id
        `,
        [['010_request_lifecycle_legacy_repair.sql', '012_request_hold_stay_repair.sql']],
      );
      expect(repairMigrations?.rows).toEqual(
        migrationStatuses.filter(
          ({ id }) =>
            id === '010_request_lifecycle_legacy_repair.sql' ||
            id === '012_request_hold_stay_repair.sql',
        ),
      );

      const upgradeRepository = createPostgresBookingRequestRepository(upgradeDatabase, {
        clock: () => new Date(clockNow),
      });
      const approvedDateMismatch = await upgradeRepository.approve(
        { organizationId },
        propertyId,
        dateMismatchRequestId,
      );
      expect(approvedDateMismatch).toMatchObject({
        arrival: dateMismatchRequestQuote.arrival,
        departure: dateMismatchRequestQuote.departure,
        holdRecordId: dateMismatchRequestId,
        status: 'approved',
      });
      const mismatchedHoldAfterApproval = await pool?.query<{
        arrival: string;
        block_kind: string;
        departure: string;
        expires_at: Date | null;
        status: string;
      }>(
        `
          SELECT
            block_kind,
            status,
            lower(stay)::text AS arrival,
            upper(stay)::text AS departure,
            expires_at
          FROM ${upgradeTable('availability_blocks')}
          WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        `,
        [organizationId, propertyId, dateMismatchHoldRecordId],
      );
      expect(mismatchedHoldAfterApproval?.rows[0]).toEqual({
        arrival: dateMismatchHoldQuote.arrival,
        block_kind: 'hold',
        departure: dateMismatchHoldQuote.departure,
        expires_at: new Date(dateMismatchHoldExpiresAt),
        status: 'active',
      });
      const approvedDateMismatchOccupancy = await pool?.query<{
        arrival: string;
        block_kind: string;
        departure: string;
        status: string;
      }>(
        `
          SELECT
            block_kind,
            status,
            lower(stay)::text AS arrival,
            upper(stay)::text AS departure
          FROM ${upgradeTable('availability_blocks')}
          WHERE organization_id = $1 AND property_id = $2 AND record_id = $3
        `,
        [organizationId, propertyId, dateMismatchRequestId],
      );
      expect(approvedDateMismatchOccupancy?.rows[0]).toEqual({
        arrival: dateMismatchRequestQuote.arrival,
        block_kind: 'occupancy',
        departure: dateMismatchRequestQuote.departure,
        status: 'active',
      });
      const readLegacyFingerprintState = async () =>
        (
          await pool?.query<{
            fingerprint_version: string;
            request_fingerprint: string;
          }>(
            `
              SELECT fingerprint_version, request_fingerprint
              FROM ${upgradeTable('booking_requests')}
              WHERE request_id = $1
            `,
            [legacyRequestId],
          )
        )?.rows[0];
      const legacyFingerprintState = await readLegacyFingerprintState();
      expect(legacyFingerprintState).toEqual({
        fingerprint_version: 'legacy-md5-request-id',
        request_fingerprint: createHash('md5').update(legacyRequestId).digest('hex'),
      });
      await expect(
        upgradeRepository.submit(
          { organizationId },
          propertyId,
          upgradeInput(`legacy-changed-before-upgrade-${runId}`, { guestCount: 1 }),
          { idempotencyKey: legacyKey, deferInventory: true },
        ),
      ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
      expect(await readLegacyFingerprintState()).toEqual(legacyFingerprintState);

      const equalRetryInput = upgradeInput(`legacy-retry-${runId}`);
      const canonicalFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            propertyId,
            equalRetryInput.arrival,
            equalRetryInput.departure,
            equalRetryInput.guestCount,
            equalRetryInput.guestName,
            equalRetryInput.guestEmail,
            equalRetryInput.message,
            equalRetryInput.quote,
          ]),
        )
        .digest('hex');
      expect(canonicalFingerprint).toMatch(/^[a-f0-9]{64}$/u);

      const retried = await upgradeRepository.submit(
        { organizationId },
        propertyId,
        equalRetryInput,
        { idempotencyKey: legacyKey, deferInventory: true },
      );
      expect(retried).toMatchObject({
        id: legacyRequestId,
        requestFingerprint: canonicalFingerprint,
        status: 'pending',
        fingerprintVersion: 'sha256-v1',
      });
      expect(retried.holdRecordId).toBeUndefined();
      const upgradedFingerprintState = {
        fingerprint_version: 'sha256-v1',
        request_fingerprint: canonicalFingerprint,
      };
      expect(await readLegacyFingerprintState()).toEqual(upgradedFingerprintState);

      const stableRetry = await upgradeRepository.submit(
        { organizationId },
        propertyId,
        equalRetryInput,
        { idempotencyKey: legacyKey, deferInventory: true },
      );
      expect(stableRetry).toEqual(retried);
      expect(await readLegacyFingerprintState()).toEqual(upgradedFingerprintState);

      await expect(
        upgradeRepository.submit(
          { organizationId },
          propertyId,
          upgradeInput(`legacy-changed-after-upgrade-${runId}`, { guestCount: 1 }),
          { idempotencyKey: legacyKey, deferInventory: true },
        ),
      ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });

      expect(await readLegacyFingerprintState()).toEqual(upgradedFingerprintState);
      await expect(
        upgradeRepository.approve({ organizationId }, propertyId, legacyRequestId),
      ).resolves.toMatchObject({
        status: 'approved',
      });
      const occupancy = await pool?.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM ${upgradeTable('availability_blocks')}
          WHERE record_id = $1 AND block_kind = 'occupancy' AND status = 'active'
        `,
        [legacyRequestId],
      );
      expect(occupancy?.rows[0]?.count).toBe('1');
    } finally {
      try {
        await upgradeDatabase?.close();
      } finally {
        try {
          await pool?.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
        } finally {
          await rm(temporaryMigrationDirectory, { force: true, recursive: true });
        }
      }
    }
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
        null as unknown as { readonly idempotencyKey: string },
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
