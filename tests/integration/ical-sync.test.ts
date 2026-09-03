import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  parseICalCalendar,
  reconcileICalFeed,
  type ICalBlockStore,
  type ICalBlockRecord,
  type ICalEvent,
  type ICalScope,
} from '../../packages/channel-ical/src/index.js';
import {
  createPostgresAvailabilityRepository,
  createPostgresICalBlockStore,
  createPostgresOrganizationRepository,
  createPostgresDatabase,
  createPostgresPropertyRepository,
  runMigrations,
  type AvailabilityRepository,
  type OrganizationRepository,
  type PostgresDatabasePort,
  type PropertyRepository,
} from '../../packages/database-postgres/src/index.js';
import {
  MIGRATION_FILES,
  runMigrationsFromDirectory,
} from '../../packages/database-postgres/src/database/migrations.js';
import type { PropertyConfigurationInput } from '../../packages/booking-core/src/index.js';

const connectionString =
  process.env['DATABASE_URL'] ??
  'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local';
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const integrationSchema = `ical_sync_test_${runId}`;
const table = (name: string): string => `"${integrationSchema}"."${name}"`;
const sourceId = 'airbnb-main';

function makeProperty(id: string): PropertyConfigurationInput {
  return {
    id,
    name: 'iCal Integration Bungalow',
    summary: 'A tenant-scoped property used by the iCal integration test.',
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
    operationalNotes: 'Private operational note.',
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(
    new URL(`../../packages/channel-ical/test/fixtures/${name}`, import.meta.url),
    'utf8',
  );
}

function firstEvent(calendar: ReturnType<typeof parseICalCalendar>): ICalEvent {
  const event = calendar.events[0];
  if (event === undefined) {
    throw new Error('test fixture did not contain an iCalendar event.');
  }
  return event;
}

function staleSnapshotStore(
  base: ICalBlockStore,
  snapshot: readonly ICalBlockRecord[],
): ICalBlockStore {
  return {
    list: async () => snapshot,
    upsert: base.upsert.bind(base),
    release: base.release.bind(base),
    withReconciliation: (scope, source, work) =>
      base.withReconciliation(scope, source, (locked) =>
        work({
          list: async () => snapshot,
          upsert: locked.upsert.bind(locked),
          release: locked.release.bind(locked),
          withReconciliation: locked.withReconciliation.bind(locked),
        }),
      ),
  };
}

describe('PostgreSQL iCalendar blocks and availability coexistence', () => {
  let pool: Pool | undefined;
  let database: PostgresDatabasePort | undefined;
  let organizations: OrganizationRepository;
  let properties: PropertyRepository;
  let availability: AvailabilityRepository;
  let store: ICalBlockStore;
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
    store = createPostgresICalBlockStore(database);
  });

  beforeEach(async () => {
    const testId = randomUUID().replaceAll('-', '').slice(0, 12);
    organizationAId = `ical-a-${testId}`;
    organizationBId = `ical-b-${testId}`;
    propertyId = `ical-property-${testId}`;
    await organizations.create({ id: organizationAId, name: 'iCal Organization A' });
    await organizations.create({ id: organizationBId, name: 'iCal Organization B' });
    await properties.create({ organizationId: organizationAId }, makeProperty(propertyId));
    await properties.create({ organizationId: organizationBId }, makeProperty(propertyId));
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

  it('persists source/UID blocks idempotently and makes them unavailable', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const calendar = parseICalCalendar(await fixture('valid-airbnb.ics'));

    const first = await reconcileICalFeed(
      scope,
      sourceId,
      [calendar.events[0] as NonNullable<(typeof calendar.events)[0]>],
      store,
    );
    expect(first.decisions).toMatchObject([{ action: 'created' }]);
    expect(await store.list(scope, sourceId)).toHaveLength(1);
    await expect(
      availability.isAvailable({ organizationId: organizationAId }, propertyId, {
        arrival: '2026-08-10',
        departure: '2026-08-14',
      }),
    ).resolves.toBe(false);

    const repeated = await reconcileICalFeed(
      scope,
      sourceId,
      [calendar.events[0] as NonNullable<(typeof calendar.events)[0]>],
      store,
    );
    expect(repeated.decisions).toMatchObject([{ action: 'unchanged' }]);
    expect(await store.list(scope, sourceId)).toHaveLength(1);
  });

  it('releases only an explicit newer cancellation and never crosses tenants', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const calendar = parseICalCalendar(await fixture('valid-airbnb.ics'));
    await reconcileICalFeed(
      scope,
      sourceId,
      [calendar.events[0] as NonNullable<(typeof calendar.events)[0]>],
      store,
    );

    const cancelled = parseICalCalendar(await fixture('cancelled-event.ics'));
    const result = await reconcileICalFeed(scope, sourceId, cancelled.events, store);
    expect(result.decisions).toMatchObject([{ action: 'released' }]);
    await expect(
      availability.isAvailable({ organizationId: organizationAId }, propertyId, {
        arrival: '2026-08-10',
        departure: '2026-08-14',
      }),
    ).resolves.toBe(true);
    expect(await store.list({ organizationId: organizationBId, propertyId }, sourceId)).toEqual([]);
  });

  it('persists cancellation version provenance so stale reappearance stays released', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const original = parseICalCalendar(await fixture('valid-airbnb.ics')).events[0];
    const cancellation = parseICalCalendar(await fixture('cancelled-event.ics')).events[0];
    if (original === undefined || cancellation === undefined) {
      throw new Error('iCalendar integration fixtures must contain the expected event.');
    }

    await reconcileICalFeed(scope, sourceId, [original], store);
    await reconcileICalFeed(scope, sourceId, [cancellation], store);
    expect(await store.list(scope, sourceId)).toMatchObject([
      { status: 'released', sequence: 3, lastModified: '2026-07-03T12:00:00.000Z' },
    ]);

    const stale = await reconcileICalFeed(scope, sourceId, [original], store);
    expect(stale.decisions).toMatchObject([
      { action: 'needs_review', reason: 'reappeared_without_new_version' },
    ]);
    expect(await store.list(scope, sourceId)).toMatchObject([{ status: 'released', sequence: 3 }]);
  });

  it('persists the maximum sequence and rejects invalid reconciliation and adapter values', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));
    const maximum = Object.freeze({
      ...event,
      uid: `${event.uid}-maximum-sequence`,
      sequence: 2_147_483_647,
      lastModified: '2026-07-04T12:00:00.000Z',
    });

    await expect(reconcileICalFeed(scope, sourceId, [maximum], store)).resolves.toMatchObject({
      decisions: [{ action: 'created' }],
    });
    await expect(store.list(scope, sourceId)).resolves.toMatchObject([
      { uid: maximum.uid, status: 'active', sequence: 2_147_483_647 },
    ]);

    for (const [index, sequence] of [-1, 1.5, 2_147_483_648].entries()) {
      const invalidEvent = Object.freeze({
        ...event,
        uid: `${event.uid}-invalid-sequence-${index}`,
        sequence,
      });
      await expect(reconcileICalFeed(scope, sourceId, [invalidEvent], store)).rejects.toThrow(
        'iCalendar event sequence is invalid.',
      );

      const invalidRecord: ICalBlockRecord = Object.freeze({
        organizationId: scope.organizationId,
        propertyId: scope.propertyId,
        sourceId,
        uid: invalidEvent.uid,
        arrival: invalidEvent.arrival,
        departure: invalidEvent.departure,
        status: 'active',
        eventStatus: invalidEvent.status,
        sequence,
        lastModified: invalidEvent.lastModified,
        summary: invalidEvent.summary,
      });
      await expect(store.upsert(scope, invalidRecord)).rejects.toMatchObject({
        name: 'PersistenceError',
        code: 'invalid_availability_id',
      });
      await expect(
        store.release(scope, sourceId, maximum.uid, {
          sequence,
          lastModified: maximum.lastModified,
          summary: maximum.summary,
        }),
      ).rejects.toMatchObject({
        name: 'PersistenceError',
        code: 'invalid_availability_id',
      });

      const records = await store.list(scope, sourceId);
      expect(records).toHaveLength(1);
      expect(records).toMatchObject([
        { uid: maximum.uid, status: 'active', sequence: 2_147_483_647 },
      ]);
    }
  });

  it('normalizes legacy sequence overflow during the 010 to 011 upgrade', async () => {
    if (pool === undefined) {
      throw new Error('iCalendar integration pool was not initialized.');
    }

    const upgradeSchema = `ical_sequence_upgrade_test_${runId}`;
    const upgradeTable = (name: string): string => `"${upgradeSchema}"."${name}"`;
    const upgradeDatabase = createPostgresDatabase({
      connectionString,
      schema: upgradeSchema,
    });
    const migrationDirectory = fileURLToPath(
      new URL('../../packages/database-postgres/migrations/', import.meta.url),
    );
    const upgradeOrganizationId = `ical-upgrade-${runId}`;
    const upgradePropertyId = `ical-upgrade-property-${runId}`;
    const upgradeScope: ICalScope = {
      organizationId: upgradeOrganizationId,
      propertyId: upgradePropertyId,
    };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));
    const maximum = Object.freeze({
      ...event,
      uid: `${event.uid}-legacy-sequence-overflow`,
      sequence: 2_147_483_647,
      lastModified: '2026-07-05T12:00:00.000Z',
    });
    const insertBlock = `
      INSERT INTO ${upgradeTable('ical_blocks')} (
        organization_id,
        property_id,
        source_id,
        external_uid,
        arrival,
        departure,
        status,
        event_status,
        sequence,
        last_modified,
        summary
      )
      VALUES ($1, $2, $3, $4, $5::date, $6::date, 'active', $7, $8, $9::timestamptz, $10)
    `;

    try {
      await runMigrationsFromDirectory(
        upgradeDatabase,
        migrationDirectory,
        MIGRATION_FILES.slice(0, 10),
      );

      const upgradeOrganizations = createPostgresOrganizationRepository(upgradeDatabase);
      const upgradeProperties = createPostgresPropertyRepository(upgradeDatabase);
      await upgradeOrganizations.create({
        id: upgradeOrganizationId,
        name: 'iCalendar Sequence Upgrade Tenant',
      });
      await upgradeProperties.create(
        { organizationId: upgradeOrganizationId },
        makeProperty(upgradePropertyId),
      );
      await pool.query(insertBlock, [
        upgradeOrganizationId,
        upgradePropertyId,
        sourceId,
        maximum.uid,
        maximum.arrival,
        maximum.departure,
        maximum.status,
        2_147_483_648,
        maximum.lastModified,
        maximum.summary,
      ]);

      await runMigrations(upgradeDatabase);

      await expect(
        pool.query<{ sequence: string }>(
          `
            SELECT sequence::text AS sequence
            FROM ${upgradeTable('ical_blocks')}
            WHERE organization_id = $1
              AND property_id = $2
              AND source_id = $3
              AND external_uid = $4
          `,
          [upgradeOrganizationId, upgradePropertyId, sourceId, maximum.uid],
        ),
      ).resolves.toMatchObject({ rows: [{ sequence: '2147483647' }] });

      const upgradeStore = createPostgresICalBlockStore(upgradeDatabase);
      await expect(upgradeStore.list(upgradeScope, sourceId)).resolves.toMatchObject([
        { uid: maximum.uid, status: 'active', sequence: 2_147_483_647 },
      ]);
      await expect(
        reconcileICalFeed(upgradeScope, sourceId, [maximum], upgradeStore),
      ).resolves.toMatchObject({
        decisions: [{ uid: maximum.uid, action: 'unchanged' }],
      });

      await expect(
        pool.query(insertBlock, [
          upgradeOrganizationId,
          upgradePropertyId,
          sourceId,
          `${maximum.uid}-new-overflow`,
          maximum.arrival,
          maximum.departure,
          maximum.status,
          2_147_483_648,
          maximum.lastModified,
          maximum.summary,
        ]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'ical_blocks_sequence_bounded',
      });
    } finally {
      try {
        await upgradeDatabase.close();
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${upgradeSchema}" CASCADE`);
      }
    }
  });

  it('rejects overlapping iCal and hold writes in either creation order with safe conflict errors', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));

    await availability.createHold(scope, propertyId, {
      id: `hold-before-ical-${runId}`,
      arrival: event.arrival,
      departure: event.departure,
      expiresAt: '2026-08-20T00:00:00.000Z',
    });
    await expect(reconcileICalFeed(scope, sourceId, [event], store)).rejects.toMatchObject({
      name: 'PersistenceError',
      code: 'availability_conflict',
    });
    expect(await store.list(scope, sourceId)).toEqual([]);

    await expect(
      availability.releaseHold(scope, propertyId, `hold-before-ical-${runId}`),
    ).resolves.toBe(true);

    await expect(reconcileICalFeed(scope, sourceId, [event], store)).resolves.toMatchObject({
      decisions: [{ action: 'created' }],
    });
    await expect(
      availability.createHold(scope, propertyId, {
        id: `hold-after-ical-${runId}`,
        arrival: event.arrival,
        departure: event.departure,
        expiresAt: '2026-08-20T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      name: 'PersistenceError',
      code: 'availability_conflict',
    });
    await expect(
      availability.createConfirmedOccupancy(scope, propertyId, {
        id: `occupancy-after-ical-${runId}`,
        arrival: event.arrival,
        departure: event.departure,
      }),
    ).rejects.toMatchObject({ code: 'availability_conflict' });
    await expect(store.release(scope, sourceId, event.uid)).resolves.toBe(true);
  });

  it('accepts adjacent stays, isolates tenants, and honors explicit iCal cancellation and hold release', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const otherScope: ICalScope = { organizationId: organizationBId, propertyId };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));

    await expect(reconcileICalFeed(scope, sourceId, [event], store)).resolves.toMatchObject({
      decisions: [{ action: 'created' }],
    });
    await expect(
      availability.createHold(scope, propertyId, {
        id: `adjacent-hold-${runId}`,
        arrival: event.departure,
        departure: '2026-08-16',
        expiresAt: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'held' });
    await expect(
      availability.createHold(otherScope, propertyId, {
        id: `isolated-hold-${runId}`,
        arrival: event.arrival,
        departure: event.departure,
        expiresAt: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'held' });

    await expect(
      availability.releaseHold(scope, propertyId, `adjacent-hold-${runId}`),
    ).resolves.toBe(true);
    const cancellation = firstEvent(parseICalCalendar(await fixture('cancelled-event.ics')));
    await expect(reconcileICalFeed(scope, sourceId, [cancellation], store)).resolves.toMatchObject({
      decisions: [{ action: 'released' }],
    });
    await expect(
      availability.createHold(scope, propertyId, {
        id: `hold-after-cancel-${runId}`,
        arrival: event.arrival,
        departure: event.departure,
        expiresAt: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'held' });

    await expect(
      availability.releaseHold(otherScope, propertyId, `isolated-hold-${runId}`),
    ).resolves.toBe(true);
    await expect(
      availability.releaseHold(scope, propertyId, `hold-after-cancel-${runId}`),
    ).resolves.toBe(true);
  });

  it('does not claim an iCal update when the atomic store write rejects an overlap', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));
    await reconcileICalFeed(scope, sourceId, [event], store);
    await availability.createHold(scope, propertyId, {
      id: `hold-for-update-${runId}`,
      arrival: '2026-08-14',
      departure: '2026-08-18',
      expiresAt: '2026-08-20T00:00:00.000Z',
    });

    const changed = Object.freeze({
      ...event,
      arrival: '2026-08-13',
      departure: '2026-08-16',
      sequence: 3,
      lastModified: '2026-07-04T12:00:00.000Z',
    });
    await expect(reconcileICalFeed(scope, sourceId, [changed], store)).rejects.toMatchObject({
      code: 'availability_conflict',
    });
    expect(await store.list(scope, sourceId)).toMatchObject([
      { uid: event.uid, arrival: event.arrival, departure: event.departure, status: 'active' },
    ]);
    await expect(
      availability.releaseHold(scope, propertyId, `hold-for-update-${runId}`),
    ).resolves.toBe(true);
    await expect(store.release(scope, sourceId, event.uid)).resolves.toBe(true);
  });

  it('allows exactly one iCal or hold writer in each of 100 simultaneous overlapping races', async () => {
    const scope: ICalScope = { organizationId: organizationAId, propertyId };
    const event = firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics')));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const uid = `${event.uid}-${attempt}`;
      const holdInput = {
        id: `race-hold-${runId}-${attempt}`,
        arrival: event.arrival,
        departure: event.departure,
        expiresAt: '2026-08-20T00:00:00.000Z',
      };
      const raceEvent = Object.freeze({ ...event, uid });
      const writes =
        attempt % 2 === 0
          ? [
              availability.createHold(scope, propertyId, holdInput),
              reconcileICalFeed(scope, sourceId, [raceEvent], store),
            ]
          : [
              reconcileICalFeed(scope, sourceId, [raceEvent], store),
              availability.createHold(scope, propertyId, holdInput),
            ];
      const results = await Promise.allSettled(writes);
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const rejected = results.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { name: 'PersistenceError', code: 'availability_conflict' },
      });

      const holdResult = results[attempt % 2 === 0 ? 0 : 1];
      if (holdResult?.status === 'fulfilled' && 'id' in holdResult.value) {
        await availability.releaseHold(scope, propertyId, holdResult.value.id);
      } else {
        await expect(store.release(scope, sourceId, uid)).resolves.toBe(true);
      }
    }
  }, 120_000);

  it('keeps the newest PostgreSQL event when two workers race with stale snapshots, including cancellation ordering', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const scope: ICalScope = { organizationId: organizationAId, propertyId };
      const uid = `stale-snapshot-${runId}-${attempt}`;
      const original = Object.freeze(
        firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics'))),
      );
      const oldEvent = Object.freeze({ ...original, uid, sequence: 1 });
      await reconcileICalFeed(scope, sourceId, [oldEvent], store);
      const staleRows = await store.list(scope, sourceId);
      const workerB = createPostgresICalBlockStore(database as PostgresDatabasePort);

      if (attempt % 2 === 0) {
        await reconcileICalFeed(
          scope,
          sourceId,
          [Object.freeze({ ...oldEvent, status: 'confirmed' as const, sequence: 2 })],
          workerB,
        );
        const staleCancellation = Object.freeze({
          ...oldEvent,
          status: 'cancelled' as const,
        });
        const result = await reconcileICalFeed(
          scope,
          sourceId,
          [staleCancellation],
          staleSnapshotStore(
            createPostgresICalBlockStore(database as PostgresDatabasePort),
            staleRows,
          ),
        );
        expect(result.decisions).toMatchObject([
          { uid, action: 'needs_review', reason: 'stale_write' },
        ]);
        await expect(store.list(scope, sourceId)).resolves.toMatchObject([
          { uid, status: 'active', sequence: 2 },
        ]);
      } else {
        const newerCancellation = Object.freeze({
          ...oldEvent,
          status: 'cancelled' as const,
          sequence: 3,
        });
        await reconcileICalFeed(scope, sourceId, [newerCancellation], workerB);
        const result = await reconcileICalFeed(
          scope,
          sourceId,
          [oldEvent],
          staleSnapshotStore(
            createPostgresICalBlockStore(database as PostgresDatabasePort),
            staleRows,
          ),
        );
        expect(result.decisions).toMatchObject([
          { uid, action: 'needs_review', reason: 'stale_write' },
        ]);
        await expect(store.list(scope, sourceId)).resolves.toMatchObject([
          { uid, status: 'released', sequence: 3 },
        ]);
      }

      await pool?.query(
        `DELETE FROM ${table('ical_blocks')} WHERE organization_id = $1 AND property_id = $2 AND source_id = $3 AND external_uid = $4`,
        [organizationAId, propertyId, sourceId, uid],
      );
    }
  }, 120_000);

  it('keeps the newest event when two PostgreSQL workers reconcile concurrently', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const scope: ICalScope = { organizationId: organizationAId, propertyId };
      const uid = `concurrent-snapshot-${runId}-${attempt}`;
      const original = Object.freeze(
        firstEvent(parseICalCalendar(await fixture('valid-airbnb.ics'))),
      );
      const oldEvent = Object.freeze({ ...original, uid, sequence: 1 });
      await reconcileICalFeed(scope, sourceId, [oldEvent], store);
      const workerA = createPostgresICalBlockStore(database as PostgresDatabasePort);
      const workerB = createPostgresICalBlockStore(database as PostgresDatabasePort);

      if (attempt % 2 === 0) {
        const newerActive = Object.freeze({
          ...oldEvent,
          status: 'confirmed' as const,
          sequence: 2,
        });
        const staleCancellation = Object.freeze({
          ...oldEvent,
          status: 'cancelled' as const,
        });
        await Promise.all([
          reconcileICalFeed(scope, sourceId, [newerActive], workerA),
          reconcileICalFeed(scope, sourceId, [staleCancellation], workerB),
        ]);
        await expect(store.list(scope, sourceId)).resolves.toMatchObject([
          { uid, status: 'active', sequence: 2 },
        ]);
      } else {
        const newerCancellation = Object.freeze({
          ...oldEvent,
          status: 'cancelled' as const,
          sequence: 3,
        });
        await Promise.all([
          reconcileICalFeed(scope, sourceId, [newerCancellation], workerA),
          reconcileICalFeed(scope, sourceId, [oldEvent], workerB),
        ]);
        await expect(store.list(scope, sourceId)).resolves.toMatchObject([
          { uid, status: 'released', sequence: 3 },
        ]);
      }

      await pool?.query(
        `DELETE FROM ${table('ical_blocks')} WHERE organization_id = $1 AND property_id = $2 AND source_id = $3 AND external_uid = $4`,
        [organizationAId, propertyId, sourceId, uid],
      );
    }
  }, 120_000);
});
