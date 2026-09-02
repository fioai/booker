import { ICAL_SEQUENCE_MAX } from './protocol-limits.js';
import type { ICalEvent, ICalEventStatus } from './parse.js';

export interface ICalScope {
  readonly organizationId: string;
  readonly propertyId: string;
}

export type ICalBlockStatus = 'active' | 'released';

export interface ICalBlockRecord {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly sourceId: string;
  readonly uid: string;
  readonly arrival: string;
  readonly departure: string;
  readonly status: ICalBlockStatus;
  readonly eventStatus: ICalEventStatus;
  readonly sequence: number | null;
  readonly lastModified: string | null;
  readonly summary: string | null;
}

export interface ICalReleaseProvenance {
  readonly sequence: number | null;
  readonly lastModified: string | null;
  readonly summary: string | null;
}

export interface ICalBlockStore {
  list(scope: ICalScope, sourceId: string): Promise<readonly ICalBlockRecord[]>;
  upsert(scope: ICalScope, record: ICalBlockRecord): Promise<ICalBlockRecord>;
  release(
    scope: ICalScope,
    sourceId: string,
    uid: string,
    provenance?: ICalReleaseProvenance,
  ): Promise<boolean>;
  /** Holds the distributed source/property reconciliation lock for the full run. */
  withReconciliation<T>(
    scope: ICalScope,
    sourceId: string,
    work: (store: ICalBlockStore) => Promise<T>,
  ): Promise<T>;
}

export class ICalStaleWriteError extends Error {
  readonly code = 'ical_stale_write' as const;

  constructor() {
    super('iCalendar reconciliation lost a compare-and-set write race.');
    this.name = 'ICalStaleWriteError';
  }
}

export type ICalReconciliationAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'released'
  | 'retained_missing'
  | 'needs_review'
  | 'ignored_cancelled';

export interface ICalReconciliationDecision {
  readonly uid: string;
  readonly action: ICalReconciliationAction;
  readonly reason?: string;
}

export interface ICalReconciliationResult {
  readonly decisions: readonly ICalReconciliationDecision[];
  readonly records: readonly ICalBlockRecord[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const UID_MAX_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_NIGHTS = 3_660;

function hasUnsafeControlCharacters(value: string, allowLineFeed = false): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) as number;
    return (code <= 31 && !(allowLineFeed && code === 10)) || (code >= 127 && code <= 159);
  });
}

function validateIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a bounded identifier.`);
  }
}

function validateScope(scope: ICalScope): void {
  validateIdentifier(scope?.organizationId, 'organizationId');
  validateIdentifier(scope?.propertyId, 'propertyId');
}

function validateSourceId(sourceId: string): string {
  validateIdentifier(sourceId, 'sourceId');
  return sourceId;
}

function dayNumber(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthStart = dayNumber(year, month, 1);
  const nextMonthStart = dayNumber(nextYear, nextMonth, 1);
  return dayNumber(year, month, day) >= monthStart && dayNumber(year, month, day) < nextMonthStart;
}

function intervalNights(arrival: string, departure: string): number {
  return (
    dayNumber(
      Number(departure.slice(0, 4)),
      Number(departure.slice(5, 7)),
      Number(departure.slice(8, 10)),
    ) -
    dayNumber(
      Number(arrival.slice(0, 4)),
      Number(arrival.slice(5, 7)),
      Number(arrival.slice(8, 10)),
    )
  );
}

function validateUid(uid: unknown): asserts uid is string {
  if (
    typeof uid !== 'string' ||
    uid.trim().length === 0 ||
    uid !== uid.trim() ||
    uid.length > UID_MAX_LENGTH ||
    hasUnsafeControlCharacters(uid)
  ) {
    throw new TypeError('iCalendar event UID is invalid.');
  }
}

function validateEvent(event: ICalEvent): void {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError('iCalendar event contains an invalid bounded stay.');
  }
  validateUid(event.uid);
  if (
    !validDate(event.arrival) ||
    !validDate(event.departure) ||
    intervalNights(event.arrival, event.departure) <= 0 ||
    intervalNights(event.arrival, event.departure) > MAX_NIGHTS
  ) {
    throw new TypeError('iCalendar event contains an invalid bounded stay.');
  }
  if (
    event.status !== 'confirmed' &&
    event.status !== 'tentative' &&
    event.status !== 'cancelled' &&
    event.status !== 'unknown'
  ) {
    throw new TypeError('iCalendar event status is invalid.');
  }
  if (
    event.sequence !== null &&
    (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > ICAL_SEQUENCE_MAX)
  ) {
    throw new TypeError('iCalendar event sequence is invalid.');
  }
  if (
    event.lastModified !== null &&
    (typeof event.lastModified !== 'string' || Number.isNaN(Date.parse(event.lastModified)))
  ) {
    throw new TypeError('iCalendar event modification timestamp is invalid.');
  }
  if (
    event.summary !== null &&
    (typeof event.summary !== 'string' ||
      event.summary.length > MAX_SUMMARY_LENGTH ||
      hasUnsafeControlCharacters(event.summary, true))
  ) {
    throw new TypeError('iCalendar event summary is too long.');
  }
}

function validateStoredRecord(scope: ICalScope, sourceId: string, record: ICalBlockRecord): void {
  if (
    typeof record !== 'object' ||
    record === null ||
    record.organizationId !== scope.organizationId ||
    record.propertyId !== scope.propertyId ||
    record.sourceId !== sourceId ||
    record.status !== 'active'
  ) {
    throw new TypeError('iCalendar record does not match the requested tenant scope.');
  }
  validateEvent({
    uid: record.uid,
    arrival: record.arrival,
    departure: record.departure,
    status: record.eventStatus,
    sequence: record.sequence,
    lastModified: record.lastModified,
    summary: record.summary,
  });
}

function recordKey(scope: ICalScope, sourceId: string, uid: string): string {
  return `${scope.organizationId}\u0000${scope.propertyId}\u0000${sourceId}\u0000${uid}`;
}

function sameEvent(left: ICalBlockRecord, right: ICalBlockRecord): boolean {
  return (
    left.arrival === right.arrival &&
    left.departure === right.departure &&
    left.eventStatus === right.eventStatus &&
    left.sequence === right.sequence &&
    left.lastModified === right.lastModified &&
    left.summary === right.summary &&
    left.status === right.status
  );
}

function versionIsNewer(event: ICalEvent, existing: ICalBlockRecord): boolean {
  if (event.sequence !== null || existing.sequence !== null) {
    if (event.sequence === null) {
      return false;
    }
    if (existing.sequence === null || event.sequence > existing.sequence) {
      return true;
    }
    if (event.sequence < existing.sequence) {
      return false;
    }
  }
  if (event.lastModified !== null || existing.lastModified !== null) {
    if (event.lastModified === null) {
      return false;
    }
    if (existing.lastModified === null) {
      return true;
    }
    return Date.parse(event.lastModified) > Date.parse(existing.lastModified);
  }
  return false;
}

function versionIsOlder(event: ICalEvent, existing: ICalBlockRecord): boolean {
  if (event.sequence !== null && existing.sequence !== null) {
    if (event.sequence !== existing.sequence) {
      return event.sequence < existing.sequence;
    }
    if (event.lastModified !== null && existing.lastModified !== null) {
      return Date.parse(event.lastModified) < Date.parse(existing.lastModified);
    }
    return false;
  }
  if (event.sequence === null && existing.sequence !== null) {
    if (event.lastModified !== null && existing.lastModified !== null) {
      return Date.parse(event.lastModified) < Date.parse(existing.lastModified);
    }
    return false;
  }
  if (event.sequence !== null && existing.sequence === null) {
    return false;
  }
  if (event.lastModified !== null && existing.lastModified !== null) {
    return Date.parse(event.lastModified) < Date.parse(existing.lastModified);
  }
  return false;
}

function hasProvenance(event: Pick<ICalEvent, 'sequence' | 'lastModified'>): boolean {
  return event.sequence !== null || event.lastModified !== null;
}

function hasSameProvenance(event: ICalEvent, existing: ICalBlockRecord): boolean {
  return event.sequence === existing.sequence && event.lastModified === existing.lastModified;
}

function activeRecord(scope: ICalScope, sourceId: string, event: ICalEvent): ICalBlockRecord {
  return Object.freeze({
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    sourceId,
    uid: event.uid,
    arrival: event.arrival,
    departure: event.departure,
    status: 'active' as const,
    eventStatus: event.status,
    sequence: event.sequence,
    lastModified: event.lastModified,
    summary: event.summary,
  });
}

function eventFromRecord(record: ICalBlockRecord): ICalEvent {
  return {
    uid: record.uid,
    arrival: record.arrival,
    departure: record.departure,
    status: record.eventStatus,
    sequence: record.sequence,
    lastModified: record.lastModified,
    summary: record.summary,
  };
}

function recordVersionIsAtLeast(next: ICalBlockRecord, existing: ICalBlockRecord): boolean {
  return sameEvent(next, existing) || versionIsNewer(eventFromRecord(next), existing);
}

function provenanceVersionIsAtLeast(
  next: Pick<
    ICalBlockRecord,
    'uid' | 'sequence' | 'lastModified' | 'arrival' | 'departure' | 'eventStatus' | 'summary'
  >,
  existing: ICalBlockRecord,
): boolean {
  return (
    (next.sequence === existing.sequence && next.lastModified === existing.lastModified) ||
    versionIsNewer(
      {
        uid: next.uid,
        arrival: next.arrival,
        departure: next.departure,
        status: next.eventStatus,
        sequence: next.sequence,
        lastModified: next.lastModified,
        summary: next.summary,
      },
      existing,
    )
  );
}

function deduplicateEvents(events: readonly ICalEvent[]): {
  readonly events: readonly ICalEvent[];
  readonly conflicts: ReadonlySet<string>;
} {
  const byUid = new Map<string, ICalEvent>();
  const conflicts = new Set<string>();
  for (const event of events) {
    validateEvent(event);
    const previous = byUid.get(event.uid);
    if (previous === undefined) {
      byUid.set(event.uid, event);
      continue;
    }
    conflicts.add(event.uid);
  }
  return {
    events: Object.freeze(
      [...byUid.values()].sort((left, right) => left.uid.localeCompare(right.uid)),
    ),
    conflicts,
  };
}

export async function reconcileICalFeed(
  scope: ICalScope,
  sourceId: string,
  events: readonly ICalEvent[],
  store: ICalBlockStore,
): Promise<ICalReconciliationResult> {
  validateScope(scope);
  const source = validateSourceId(sourceId);
  return store.withReconciliation(scope, source, (lockedStore) =>
    reconcileLocked(scope, source, events, lockedStore),
  );
}

async function reconcileLocked(
  scope: ICalScope,
  source: string,
  events: readonly ICalEvent[],
  store: ICalBlockStore,
): Promise<ICalReconciliationResult> {
  const existingRecords = await store.list(scope, source);
  for (const record of existingRecords) {
    if (
      record.organizationId !== scope.organizationId ||
      record.propertyId !== scope.propertyId ||
      record.sourceId !== source
    ) {
      throw new Error('iCalendar store returned a record outside the requested tenant scope.');
    }
  }
  const existing = new Map(existingRecords.map((record) => [record.uid, record]));
  const { events: uniqueEvents, conflicts } = deduplicateEvents(events);
  const decisions: ICalReconciliationDecision[] = [];
  const seen = new Set<string>();

  for (const event of uniqueEvents) {
    seen.add(event.uid);
    if (conflicts.has(event.uid)) {
      decisions.push({ uid: event.uid, action: 'needs_review', reason: 'duplicate_uid' });
      continue;
    }
    const previous = existing.get(event.uid);
    if (event.status === 'unknown') {
      decisions.push({ uid: event.uid, action: 'needs_review', reason: 'unknown_status' });
      continue;
    }
    if (event.status === 'cancelled') {
      if (previous === undefined) {
        decisions.push({ uid: event.uid, action: 'ignored_cancelled' });
        continue;
      }
      if (previous.status === 'released') {
        if (versionIsOlder(event, previous)) {
          decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_cancellation' });
          continue;
        }
        if (versionIsNewer(event, previous)) {
          try {
            await store.release(scope, source, event.uid, {
              sequence: event.sequence,
              lastModified: event.lastModified,
              summary: event.summary,
            });
          } catch (error) {
            if (!(error instanceof ICalStaleWriteError)) {
              throw error;
            }
            decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_write' });
            continue;
          }
        }
        decisions.push({ uid: event.uid, action: 'unchanged' });
        continue;
      }
      if (versionIsOlder(event, previous)) {
        decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_cancellation' });
        continue;
      }
      if (hasProvenance(previous) && !hasProvenance(event) && !hasSameProvenance(event, previous)) {
        decisions.push({
          uid: event.uid,
          action: 'needs_review',
          reason: 'ambiguous_cancellation_version',
        });
        continue;
      }
      if (
        (event.arrival !== previous.arrival || event.departure !== previous.departure) &&
        !versionIsNewer(event, previous)
      ) {
        decisions.push({
          uid: event.uid,
          action: 'needs_review',
          reason: 'ambiguous_cancellation_change',
        });
        continue;
      }
      try {
        await store.release(scope, source, event.uid, {
          sequence: event.sequence,
          lastModified: event.lastModified,
          summary: event.summary,
        });
      } catch (error) {
        if (!(error instanceof ICalStaleWriteError)) {
          throw error;
        }
        decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_write' });
        continue;
      }
      decisions.push({ uid: event.uid, action: 'released' });
      continue;
    }

    const next = activeRecord(scope, source, event);
    if (previous === undefined) {
      try {
        await store.upsert(scope, next);
      } catch (error) {
        if (!(error instanceof ICalStaleWriteError)) {
          throw error;
        }
        decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_write' });
        continue;
      }
      decisions.push({ uid: event.uid, action: 'created' });
      continue;
    }
    if (sameEvent(previous, next)) {
      try {
        // Re-assert the exact snapshot against the store even for an apparent no-op.
        // This lets a PostgreSQL CAS detect a stale read that raced a newer worker.
        await store.upsert(scope, next);
      } catch (error) {
        if (!(error instanceof ICalStaleWriteError)) {
          throw error;
        }
        decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_write' });
        continue;
      }
      decisions.push({ uid: event.uid, action: 'unchanged' });
      continue;
    }
    if (previous.status === 'released' && !versionIsNewer(event, previous)) {
      decisions.push({
        uid: event.uid,
        action: 'needs_review',
        reason: 'reappeared_without_new_version',
      });
      continue;
    }
    if (!versionIsNewer(event, previous)) {
      decisions.push({ uid: event.uid, action: 'needs_review', reason: 'ambiguous_change' });
      continue;
    }
    try {
      await store.upsert(scope, next);
    } catch (error) {
      if (!(error instanceof ICalStaleWriteError)) {
        throw error;
      }
      decisions.push({ uid: event.uid, action: 'needs_review', reason: 'stale_write' });
      continue;
    }
    decisions.push({ uid: event.uid, action: 'updated' });
  }

  for (const record of existingRecords) {
    if (record.status === 'active' && !seen.has(record.uid)) {
      decisions.push({
        uid: record.uid,
        action: 'retained_missing',
        reason: 'missing_is_not_deletion',
      });
    }
  }

  const records = await store.list(scope, source);
  return Object.freeze({
    decisions: Object.freeze(decisions),
    records: Object.freeze([...records]),
  });
}

export function createMemoryICalBlockStore(): ICalBlockStore {
  const records = new Map<string, ICalBlockRecord>();
  const reconciliationTails = new Map<string, Promise<void>>();

  async function withReconciliation<T>(
    scope: ICalScope,
    sourceId: string,
    work: (store: ICalBlockStore) => Promise<T>,
  ): Promise<T> {
    validateScope(scope);
    validateSourceId(sourceId);
    const key = `${scope.organizationId}\u0000${scope.propertyId}\u0000${sourceId}`;
    const previous = reconciliationTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    reconciliationTails.set(key, current);
    await previous;
    try {
      return await work(memoryStore);
    } finally {
      release?.();
      if (reconciliationTails.get(key) === current) {
        reconciliationTails.delete(key);
      }
    }
  }

  const memoryStore: ICalBlockStore = {
    withReconciliation,
    list: async (scope, sourceId): Promise<readonly ICalBlockRecord[]> => {
      validateScope(scope);
      validateSourceId(sourceId);
      return Object.freeze(
        [...records.values()]
          .filter(
            (record) =>
              record.organizationId === scope.organizationId &&
              record.propertyId === scope.propertyId &&
              record.sourceId === sourceId,
          )
          .sort((left, right) => left.uid.localeCompare(right.uid))
          .map((record) => Object.freeze({ ...record })),
      );
    },
    upsert: async (scope, record): Promise<ICalBlockRecord> => {
      validateScope(scope);
      validateSourceId(record.sourceId);
      validateStoredRecord(scope, record.sourceId, record);
      const key = recordKey(scope, record.sourceId, record.uid);
      const previous = records.get(key);
      if (previous !== undefined && !recordVersionIsAtLeast(record, previous)) {
        throw new ICalStaleWriteError();
      }
      const copy = Object.freeze({ ...record });
      records.set(key, copy);
      return copy;
    },
    release: async (scope, sourceId, uid, provenance): Promise<boolean> => {
      validateScope(scope);
      validateSourceId(sourceId);
      validateUid(uid);
      const key = recordKey(scope, sourceId, uid);
      const previous = records.get(key);
      if (previous === undefined) {
        return false;
      }
      if (provenance === undefined && previous.status === 'released') {
        return false;
      }
      if (provenance !== undefined) {
        const next = Object.freeze({
          ...previous,
          status: 'released' as const,
          eventStatus: 'cancelled' as const,
          ...provenance,
        });
        if (!provenanceVersionIsAtLeast(next, previous)) {
          throw new ICalStaleWriteError();
        }
        records.set(key, next);
        return true;
      }
      records.set(
        key,
        Object.freeze({
          ...previous,
          status: 'released' as const,
          eventStatus: 'cancelled' as const,
        }),
      );
      return true;
    },
  };

  return memoryStore;
}
