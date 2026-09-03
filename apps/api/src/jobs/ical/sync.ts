import {
  createICalFetcher,
  parseICalCalendar,
  reconcileICalFeed,
  type ICalBlockStore,
  type ICalFetchedFeed,
  type ICalFetcher,
  type ICalReconciliationResult,
  type ICalScope,
} from '@booking-engine/channel-ical';

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
  readonly fetchFeed?: (url: string) => Promise<string | Uint8Array | ICalFetchedFeed>;
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
const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_url: 'The calendar source URL is invalid.',
  insecure_protocol: 'The calendar source requires HTTPS.',
  blocked_host: 'The calendar source host is not allowed.',
  blocked_address: 'The calendar source resolved to a blocked network address.',
  dns_error: 'The calendar source could not be resolved.',
  dns_rebinding: 'The calendar source DNS resolution changed during validation.',
  redirect_limit: 'The calendar source exceeded the redirect limit.',
  redirect_location: 'The calendar source returned an invalid redirect.',
  timeout: 'The calendar source request timed out.',
  body_limit: 'The calendar source body exceeded the size limit.',
  invalid_encoding: 'The calendar source body encoding is invalid.',
  http_error: 'The calendar source returned an unsuccessful response.',
  network_error: 'The calendar source request failed.',
  missing_calendar: 'The calendar source returned malformed iCalendar data.',
  invalid_component: 'The calendar source returned malformed iCalendar data.',
  missing_event: 'The calendar source did not contain a usable event.',
  event_limit: 'The calendar source contained too many events.',
  duplicate_uid: 'The calendar source contained duplicate event identifiers.',
  ambiguous_timezone: 'The calendar source contained timezone-ambiguous event data.',
  invalid_date: 'The calendar source contained an invalid date.',
  invalid_interval: 'The calendar source contained an invalid stay interval.',
  invalid_input: 'The calendar source returned malformed iCalendar data.',
  invalid_line: 'The calendar source returned malformed iCalendar data.',
  line_too_long: 'The calendar source returned an oversized iCalendar line.',
  missing_property: 'The calendar source returned an incomplete event.',
  duplicate_property: 'The calendar source returned a duplicate event property.',
  invalid_uid: 'The calendar source returned an invalid event identifier.',
  invalid_sequence: 'The calendar source returned an invalid event version.',
  invalid_timestamp: 'The calendar source returned an invalid event timestamp.',
  invalid_status: 'The calendar source returned an unsupported event status.',
  text_too_long: 'The calendar source returned oversized event text.',
  invalid_transparency: 'The calendar source returned unsupported event transparency.',
  unsupported_recurrence: 'The calendar source contained unsupported recurrence data.',
});

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
  const code = Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, candidate)
    ? candidate
    : 'sync_failed';
  return Object.freeze({
    code,
    message: SAFE_ERROR_MESSAGES[code] ?? 'Calendar synchronization failed.',
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
    health(scope: ICalScope, sourceId: string): ICalSyncHealth {
      return currentHealth(scope, sourceId);
    },

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
        const fetched =
          dependencies.fetchFeed === undefined
            ? (await fetcher.fetch(config.url)).body
            : await dependencies.fetchFeed(config.url);
        const body =
          typeof fetched === 'string' || fetched instanceof Uint8Array ? fetched : fetched.body;
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

export interface ICalStay {
  readonly arrival: string;
  readonly departure: string;
}

export interface AvailabilityRecheckPort {
  isAvailable(scope: ICalScope, propertyId: string, stay: ICalStay): Promise<boolean>;
}

export class ICalCommitAvailabilityError extends Error {
  readonly code = 'stay_unavailable' as const;

  constructor() {
    super('The stay is no longer available.');
    this.name = 'ICalCommitAvailabilityError';
  }
}

export async function recheckAvailabilityBeforeCommit(
  dependencies: AvailabilityRecheckPort,
  scope: ICalScope,
  stay: ICalStay,
): Promise<void> {
  validateScope(scope);
  const available = await dependencies.isAvailable(scope, scope.propertyId, stay);
  if (!available) {
    throw new ICalCommitAvailabilityError();
  }
}

export const recheckAvailabilityBeforeApproval = recheckAvailabilityBeforeCommit;
export const recheckAvailabilityBeforePayment = recheckAvailabilityBeforeCommit;

export type { ICalFetchedFeed };
