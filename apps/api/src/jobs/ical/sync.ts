import {
  createICalFetcher,
  parseICalCalendar,
  reconcileICalFeed,
  type ICalBlockStore,
  type ICalFetcher,
  type ICalReconciliationResult,
  type ICalScope,
} from '@booking-engine/channel-ical';

import { ICAL_SOURCE_ERROR_MESSAGES } from './errors.js';

export interface ICalClock {
  now(): Date;
}

export interface ICalSyncConfig {
  readonly scope: ICalScope;
  readonly sourceId: string;
  readonly url: string;
}

export interface ICalSyncError {
  readonly code: string;
  readonly message: string;
}

export interface ICalSyncHealth {
  readonly sourceId: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly stale: boolean;
  readonly error: ICalSyncError | null;
}

export interface ICalSyncRunResult {
  readonly status: 'success' | 'failed';
  readonly health: ICalSyncHealth;
  readonly reconciliation?: ICalReconciliationResult;
}

export interface ICalSyncJobDependencies {
  readonly store: ICalBlockStore;
  readonly fetcher?: ICalFetcher;
  readonly clock?: ICalClock;
  readonly staleAfterMs?: number;
}

interface MutableHealth {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
  error: ICalSyncError | null;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function clockNow(clock: ICalClock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('iCalendar sync clock must return a valid Date.');
  }
  return new Date(now.getTime());
}

function validateScope(scope: ICalScope): void {
  if (
    typeof scope?.organizationId !== 'string' ||
    !IDENTIFIER_PATTERN.test(scope.organizationId) ||
    typeof scope?.propertyId !== 'string' ||
    !IDENTIFIER_PATTERN.test(scope.propertyId)
  ) {
    throw new TypeError('iCalendar sync scope is invalid.');
  }
}

function validateSourceId(sourceId: string): void {
  if (!IDENTIFIER_PATTERN.test(sourceId)) {
    throw new TypeError('iCalendar sourceId is invalid.');
  }
}

function healthKey(scope: ICalScope, sourceId: string): string {
  return `${scope.organizationId}\u0000${scope.propertyId}\u0000${sourceId}`;
}

function safeError(error: unknown): ICalSyncError {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const recordCode = record?.['code'];
  const candidate = typeof recordCode === 'string' ? recordCode : 'sync_failed';
  const code = Object.prototype.hasOwnProperty.call(ICAL_SOURCE_ERROR_MESSAGES, candidate)
    ? candidate
    : 'sync_failed';
  return Object.freeze({
    code,
    message: ICAL_SOURCE_ERROR_MESSAGES[code] ?? 'Calendar synchronization failed.',
  });
}

function healthSnapshot(
  sourceId: string,
  state: MutableHealth,
  now: Date,
  staleAfterMs: number,
): ICalSyncHealth {
  const isTimeStale =
    state.lastSuccessAt === null || now.getTime() - Date.parse(state.lastSuccessAt) >= staleAfterMs;
  return Object.freeze({
    sourceId,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    stale: state.stale || isTimeStale,
    error: state.error,
  });
}

export function createICalSyncJob(dependencies: ICalSyncJobDependencies) {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const staleAfterMs = dependencies.staleAfterMs ?? 6 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new RangeError('staleAfterMs must be a positive bounded integer.');
  }
  const fetcher = dependencies.fetcher ?? createICalFetcher();
  const healthStates = new Map<string, MutableHealth>();

  function stateFor(scope: ICalScope, sourceId: string): MutableHealth {
    const key = healthKey(scope, sourceId);
    const current = healthStates.get(key);
    if (current !== undefined) {
      return current;
    }
    const initial: MutableHealth = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      stale: true,
      error: null,
    };
    healthStates.set(key, initial);
    return initial;
  }

  function currentHealth(scope: ICalScope, sourceId: string): ICalSyncHealth {
    validateScope(scope);
    validateSourceId(sourceId);
    const now = clockNow(clock);
    return healthSnapshot(sourceId, stateFor(scope, sourceId), now, staleAfterMs);
  }

  return {
    health: currentHealth,

    async run(config: ICalSyncConfig): Promise<ICalSyncRunResult> {
      validateScope(config.scope);
      validateSourceId(config.sourceId);
      if (typeof config.url !== 'string' || config.url.length === 0) {
        throw new TypeError('iCalendar sync URL is required.');
      }
      const state = stateFor(config.scope, config.sourceId);
      const attemptAt = clockNow(clock).toISOString();
      state.lastAttemptAt = attemptAt;
      state.stale = true;
      state.error = null;

      try {
        const { body } = await fetcher.fetch(config.url);
        const calendar = parseICalCalendar(body);
        const reconciliation = await reconcileICalFeed(
          config.scope,
          config.sourceId,
          calendar.events,
          dependencies.store,
        );
        state.lastSuccessAt = clockNow(clock).toISOString();
        state.stale = false;
        state.error = null;
        return Object.freeze({
          status: 'success' as const,
          health: currentHealth(config.scope, config.sourceId),
          reconciliation,
        });
      } catch (error) {
        state.error = safeError(error);
        state.stale = true;
        return Object.freeze({
          status: 'failed' as const,
          health: currentHealth(config.scope, config.sourceId),
        });
      }
    },
  };
}
