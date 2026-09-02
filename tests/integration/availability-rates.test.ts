import { randomUUID } from 'node:crypto';

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PropertyConfigurationInput } from '../../packages/booking-core/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresOrganizationRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  createPostgresRateRepository,
  runMigrations,
  type AvailabilityRepository,
  type OrganizationRepository,
  type PostgresDatabasePort,
  type PostgresTransactionPort,
  type PropertyRepository,
  type RateRepository,
} from '../../packages/database-postgres/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `availability_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;

interface TransactionQuery {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface TransactionQueryHooks {
  readonly afterQueryStarted?: (query: TransactionQuery) => Promise<void> | void;
  readonly afterQuery?: (query: TransactionQuery) => Promise<void> | void;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wrapTransactionQueries(
  source: PostgresDatabasePort,
  hooks: TransactionQueryHooks,
): PostgresDatabasePort {
  return {
    dialect: source.dialect,
    schema: source.schema,
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      return source.query<Row>(text, values);
    },
    withTransaction<T>(work: (transaction: PostgresTransactionPort) => Promise<T>): Promise<T> {
      return source.withTransaction((transaction) => {
        return work({
          async query<Row extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<QueryResult<Row>> {
            const query = { text, values };
            const resultPromise = transaction.query<Row>(text, values);
            await hooks.afterQueryStarted?.(query);
            const result = await resultPromise;
            await hooks.afterQuery?.(query);
            return result;
          },
        });
      });
    },
    close(): Promise<void> {
      return source.close();
    },
  };
}

function makeProperty(id: string): PropertyConfigurationInput {
  return {
    id,
    name: 'Tenant A Garden Bungalow',
    summary: 'A validated tenant-scoped property.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'EUR',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: [
      { type: 'queen', quantity: 1 },
      { type: 'sofa-bed', quantity: 1 },
    ],
    bathroomCount: 1,
    maximumGuests: 3,
    amenities: ['private garden'],
    hostNotes: 'Guest-visible host note.',
    operationalNotes: 'Private operational note.',
  };
}

describe('PostgreSQL availability, rates, and atomic occupancy', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let organizations: OrganizationRepository;
  let properties: PropertyRepository;
  let availability: AvailabilityRepository;
  let rates: RateRepository;
  let organizationAId: string;
  let organizationBId: string;
  let propertyId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query('SELECT 1');
    database = createPostgresDatabase({ connectionString, schema: integrationSchema });
    await runMigrations(database);
    organizations = createPostgresOrganizationRepository(database);
    properties = createPostgresPropertyRepository(database);
    availability = createPostgresAvailabilityRepository(database);
    rates = createPostgresRateRepository(database);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationAId = `org-a-${testId}`;
    organizationBId = `org-b-${testId}`;
    propertyId = `property-${testId}`;
    await organizations.create({ id: organizationAId, name: 'Organization A' });
    await organizations.create({ id: organizationBId, name: 'Organization B' });
    await properties.create({ organizationId: organizationAId }, makeProperty(propertyId));
  });

  afterEach(async () => {
    await pool?.query(`DELETE FROM ${table('organizations')} WHERE id = ANY($1::text[])`, [
      [organizationAId, organizationBId],
    ]);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${integrationSchema}" CASCADE`);
    await pool?.end();
  });

  it('persists tenant-scoped integer rates and returns a minor-unit quote', async () => {
    const plan = await rates.saveRatePlan({ organizationId: organizationAId }, propertyId, {
      currency: 'EUR',
      baseNightlyRateMinor: 12_500,
      cleaningFeeMinor: 3_500,
      minimumStayNights: 2,
      seasonalOverrides: [
        { arrival: '2026-07-01', departure: '2026-07-04', nightlyRateMinor: 15_000 },
      ],
    });

    expect(plan.baseNightlyRateMinor).toBe(12_500);
    await expect(
      rates.quote({ organizationId: organizationAId }, propertyId, {
        arrival: '2026-07-02',
        departure: '2026-07-06',
      }),
    ).resolves.toMatchObject({ totalMinor: 58_500, nightlySubtotalMinor: 55_000 });
    await expect(
      rates.saveRatePlan({ organizationId: organizationBId }, propertyId, plan),
    ).rejects.toMatchObject({ code: 'property_not_found' });
    await expect(
      rates.saveRatePlan({ organizationId: organizationAId }, propertyId, {
        ...plan,
        baseNightlyRateMinor: 1.25,
      }),
    ).rejects.toMatchObject({ code: 'rate_validation' });
  });

  it('holds a rate read snapshot lock through overrides and transaction commit', async () => {
    const scope = { organizationId: organizationAId };
    const sourceDatabase = database as PostgresDatabasePort;
    const directPool = pool as Pool;
    const propertyLockKey = `booking-engine:property:${organizationAId}:${propertyId}`;
    const planA = {
      currency: 'EUR',
      baseNightlyRateMinor: 10_000,
      cleaningFeeMinor: 1_000,
      minimumStayNights: 2,
      seasonalOverrides: [
        { arrival: '2026-08-01', departure: '2026-08-03', nightlyRateMinor: 15_000 },
      ],
    };
    const planB = {
      currency: 'EUR',
      baseNightlyRateMinor: 22_000,
      cleaningFeeMinor: 4_000,
      minimumStayNights: 1,
      seasonalOverrides: [
        { arrival: '2026-08-01', departure: '2026-08-03', nightlyRateMinor: 31_000 },
      ],
    };
    await rates.saveRatePlan(scope, propertyId, planA);

    const releaseReaderAfterPlan = createDeferred<void>();
    const releaseReaderAfterOverrides = createDeferred<void>();
    const readerPlanRead = createDeferred<TransactionQuery>();
    const readerOverridesRead = createDeferred<TransactionQuery>();
    const readingRates = createPostgresRateRepository(
      wrapTransactionQueries(sourceDatabase, {
        afterQuery(query) {
          if (query.text.includes(`FROM ${table('property_rate_plans')}`)) {
            readerPlanRead.resolve(query);
            return releaseReaderAfterPlan.promise;
          }
          if (query.text.includes(`FROM ${table('seasonal_rate_overrides')}`)) {
            readerOverridesRead.resolve(query);
            return releaseReaderAfterOverrides.promise;
          }
          return undefined;
        },
      }),
    );
    const writerLockStarted = createDeferred<TransactionQuery>();
    const writerLockAcquired = createDeferred<TransactionQuery>();
    const writerPlanQueryStarted = createDeferred<TransactionQuery>();
    const releaseWriterAfterLock = createDeferred<void>();
    let writerReachedPlanRow = false;
    const writingRates = createPostgresRateRepository(
      wrapTransactionQueries(sourceDatabase, {
        afterQueryStarted(query) {
          if (query.text.includes('pg_advisory_xact_lock')) {
            writerLockStarted.resolve(query);
          }
          if (
            query.text.includes(`INSERT INTO ${table('property_rate_plans')}`) &&
            query.values?.[0] === organizationAId &&
            query.values?.[1] === propertyId
          ) {
            writerReachedPlanRow = true;
            writerPlanQueryStarted.resolve(query);
          }
        },
        afterQuery(query) {
          if (query.text.includes('pg_advisory_xact_lock')) {
            writerLockAcquired.resolve(query);
            return releaseWriterAfterLock.promise;
          }
          return undefined;
        },
      }),
    );

    const quotePromise = readingRates.quote(scope, propertyId, {
      arrival: '2026-08-01',
      departure: '2026-08-03',
    });
    let savePromise: ReturnType<RateRepository['saveRatePlan']> | undefined;
    try {
      const planQuery = await readerPlanRead.promise;
      expect(planQuery.values).toEqual([organizationAId, propertyId]);

      const lockProbe = await directPool.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [propertyLockKey],
      );
      expect(lockProbe.rows).toEqual([{ acquired: false }]);

      savePromise = writingRates.saveRatePlan(scope, propertyId, planB);
      const startedLockQuery = await writerLockStarted.promise;
      expect(startedLockQuery.values).toEqual([propertyLockKey]);
      expect(writerReachedPlanRow).toBe(false);

      const committedSnapshot = await directPool.query<{
        base_nightly_rate_minor: string;
        cleaning_fee_minor: string;
        nightly_rate_minor: string;
      }>(
        `
          SELECT plan.base_nightly_rate_minor,
                 plan.cleaning_fee_minor,
                 override.nightly_rate_minor
          FROM ${table('property_rate_plans')} AS plan
          JOIN ${table('seasonal_rate_overrides')} AS override
            ON override.organization_id = plan.organization_id
           AND override.property_id = plan.property_id
          WHERE plan.organization_id = $1 AND plan.property_id = $2
        `,
        [organizationAId, propertyId],
      );
      expect(committedSnapshot.rows).toEqual([
        {
          base_nightly_rate_minor: '10000',
          cleaning_fee_minor: '1000',
          nightly_rate_minor: '15000',
        },
      ]);

      releaseReaderAfterPlan.resolve();
      const overridesQuery = await readerOverridesRead.promise;
      expect(overridesQuery.values).toEqual([organizationAId, propertyId]);
      expect(writerReachedPlanRow).toBe(false);

      releaseReaderAfterOverrides.resolve();
      const quote = await quotePromise;
      expect(quote).toMatchObject({
        nightlySubtotalMinor: 30_000,
        cleaningFeeMinor: 1_000,
        totalMinor: 31_000,
      });

      const acquiredLockQuery = await writerLockAcquired.promise;
      expect(acquiredLockQuery.values).toEqual([propertyLockKey]);
      expect(writerReachedPlanRow).toBe(false);
      releaseWriterAfterLock.resolve();

      const writePlanQuery = await writerPlanQueryStarted.promise;
      expect(writePlanQuery.values?.slice(0, 2)).toEqual([organizationAId, propertyId]);
      const savedPlan = await savePromise;
      expect(savedPlan).toMatchObject(planB);
      await expect(rates.getRatePlan(scope, propertyId)).resolves.toMatchObject(planB);
    } finally {
      releaseReaderAfterPlan.resolve();
      releaseReaderAfterOverrides.resolve();
      releaseWriterAfterLock.resolve();
      await Promise.allSettled([quotePromise, ...(savePromise === undefined ? [] : [savePromise])]);
    }
  });

  it('treats blocks and active holds as bounded half-open availability', async () => {
    const scope = { organizationId: organizationAId };
    await availability.createManualBlock(scope, propertyId, {
      id: `manual-${runId}`,
      arrival: '2026-08-01',
      departure: '2026-08-03',
      reason: 'Owner stay',
    });

    await expect(
      availability.isAvailable(scope, propertyId, {
        arrival: '2026-08-03',
        departure: '2026-08-05',
      }),
    ).resolves.toBe(true);
    await expect(
      availability.isAvailable(scope, propertyId, {
        arrival: '2026-08-02',
        departure: '2026-08-04',
      }),
    ).resolves.toBe(false);
    await expect(
      availability.createHold(scope, propertyId, {
        id: `blocked-hold-${runId}`,
        arrival: '2026-08-02',
        departure: '2026-08-04',
        expiresAt: '2026-08-10T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'availability_conflict' });

    await availability.releaseManualBlock(scope, propertyId, `manual-${runId}`);
    const hold = await availability.createHold(scope, propertyId, {
      id: `hold-${runId}`,

      arrival: '2026-08-02',
      departure: '2026-08-04',
      expiresAt: '2026-08-10T00:00:00.000Z',
    });
    expect(hold.status).toBe('held');
    await expect(
      availability.isAvailable(scope, propertyId, {
        arrival: '2026-08-03',
        departure: '2026-08-04',
      }),
    ).resolves.toBe(false);

    const released = await availability.releaseExpiredHolds(scope, '2026-08-11T00:00:00.000Z');
    expect(released).toBe(1);
    await expect(
      availability.isAvailable(scope, propertyId, {
        arrival: '2026-08-03',
        departure: '2026-08-04',
      }),
    ).resolves.toBe(true);

    const occupancy = await availability.createConfirmedOccupancy(scope, propertyId, {
      id: `occupancy-${runId}`,
      arrival: '2026-08-12',
      departure: '2026-08-14',
    });
    expect(occupancy.status).toBe('confirmed');
    await expect(
      availability.createHold(scope, propertyId, {
        id: `occupancy-overlap-${runId}`,
        arrival: '2026-08-13',
        departure: '2026-08-15',
        expiresAt: '2026-08-20T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'availability_conflict' });
    await expect(
      availability.isAvailable(scope, propertyId, {
        arrival: '2026-08-14',
        departure: '2026-08-15',
      }),
    ).resolves.toBe(true);
    await expect(availability.releaseOccupancy(scope, propertyId, occupancy.id)).resolves.toBe(
      true,
    );

    await expect(
      availability.createHold({ organizationId: organizationBId }, propertyId, {
        id: `wrong-tenant-${runId}`,
        arrival: '2026-08-02',
        departure: '2026-08-04',
        expiresAt: '2026-08-10T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'property_not_found' });
    await expect(
      availability.createHold(scope, propertyId, {
        id: `invalid-${runId}`,
        arrival: '2026-08-04',
        departure: '2026-08-04',
        expiresAt: '2026-08-10T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid_stay' });
  });

  it('uses a static active-row exclusion constraint without a wall-clock predicate', async () => {
    const result = await pool?.query<{ definition: string }>(
      `
        SELECT pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1
          AND rel.relname = 'availability_blocks'
          AND con.contype = 'x'
      `,
      [integrationSchema],
    );
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]?.definition).toContain('stay WITH &&');
    expect(result?.rows[0]?.definition).toMatch(/status = 'active'/u);
    expect(result?.rows[0]?.definition).not.toMatch(/current_timestamp|now\s*\(/iu);
  });
  it('rejects control and bidi formatting characters in manual block reasons', async () => {
    const scope = { organizationId: organizationAId };
    for (const [index, reason] of [
      'Owner\u0000 block',
      'Owner\u0085 block',
      'Owner\u202e block',
      'Owner\u2066 block',
    ].entries()) {
      await expect(
        availability.createManualBlock(scope, propertyId, {
          id: `invalid-reason-${runId}-${index}`,
          arrival: '2026-09-01',
          departure: '2026-09-03',
          reason,
        }),
      ).rejects.toMatchObject({ code: 'invalid_availability_id' });
    }
  });

  it('allows exactly one of two concurrent overlapping holds in each of 100 races', async () => {
    const scope = { organizationId: organizationAId };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const results = await Promise.allSettled([
        availability.createHold(scope, propertyId, {
          id: `race-a-${runId}-${attempt}`,
          arrival: '2026-09-01',
          departure: '2026-09-04',
          expiresAt: '2026-09-10T00:00:00.000Z',
        }),
        availability.createHold(scope, propertyId, {
          id: `race-b-${runId}-${attempt}`,
          arrival: '2026-09-02',
          departure: '2026-09-05',
          expiresAt: '2026-09-10T00:00:00.000Z',
        }),
      ]);
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const winner = results.find(({ status }) => status === 'fulfilled');
      if (winner?.status === 'fulfilled') {
        await availability.releaseHold(scope, propertyId, winner.value.id);
      }
    }
  }, 120_000);
});
