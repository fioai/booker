export interface SyncHealthErrorV1 {
  readonly code: string;
  readonly message: string;
}

export interface SyncHealthViewV1 {
  readonly sourceId: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly stale: boolean;
  readonly error: SyncHealthErrorV1 | null;
}

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
  availability_conflict: 'The calendar source could not update availability.',
  sync_failed: 'Calendar synchronization failed.',
});

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function safeError(error: SyncHealthErrorV1 | null): { code: string; message: string } | null {
  if (error === null) {
    return null;
  }
  const code = Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, error.code)
    ? error.code
    : 'sync_failed';
  return { code, message: SAFE_ERROR_MESSAGES[code] as string };
}

function safeTimestamp(value: string | null): string {
  return value !== null && SAFE_TIMESTAMP.test(value) ? value : 'Never';
}

export function renderSyncHealthV1(health: SyncHealthViewV1): string {
  const error = safeError(health.error);
  const needsAttention = health.stale || error !== null;
  const title = needsAttention ? 'Sync needs attention' : 'Sync healthy';
  const state = health.stale ? 'stale' : 'current';
  const errorMarkup =
    error === null
      ? ''
      : `<p data-sync-error="${escapeHtml(error.code)}">${escapeHtml(error.message)}</p>`;
  const sourceId = SAFE_IDENTIFIER.test(health.sourceId) ? health.sourceId : 'calendar source';
  const lastSuccess = safeTimestamp(health.lastSuccessAt);
  const lastAttempt = safeTimestamp(health.lastAttemptAt);
  return `<section data-sync-health="${needsAttention ? 'attention' : 'healthy'}" aria-live="polite"><h2>${title}</h2><p>${escapeHtml(sourceId)}: ${state}</p><p>Last attempt: ${escapeHtml(lastAttempt)}</p><p>Last successful sync: ${escapeHtml(lastSuccess)}</p>${errorMarkup}</section>`;
}

export const SyncHealth = renderSyncHealthV1;
