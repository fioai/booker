import { ISO_4217_ACTIVE_CODES } from './iso-4217-active.js';
import {
  createLocalDateInterval,
  type QuoteBreakdown,
  type QuoteNight,
} from './availability-rates.js';
import type { Result } from './property/configuration/types.js';

export type BookingRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type BookingRequestAction = 'approve' | 'reject' | 'expire';

export interface IllegalBookingRequestTransition {
  readonly code: 'illegal_transition';
  readonly from: BookingRequestStatus;
  readonly action: BookingRequestAction;
}

export type BookingRequestTransitionResult = Result<
  BookingRequestStatus,
  IllegalBookingRequestTransition
>;

export function transitionBookingRequest(
  status: BookingRequestStatus,
  action: BookingRequestAction,
): BookingRequestTransitionResult {
  if (status === 'pending' && action === 'approve') {
    return { ok: true, value: 'approved' };
  }
  if (status === 'pending' && action === 'reject') {
    return { ok: true, value: 'rejected' };
  }
  if (status === 'pending' && action === 'expire') {
    return { ok: true, value: 'expired' };
  }
  return {
    ok: false,
    errors: [{ code: 'illegal_transition', from: status, action }],
  };
}

export type QuoteSnapshotValidationCode =
  | 'invalid_quote'
  | 'invalid_currency'
  | 'invalid_amount'
  | 'invalid_nightly_entry'
  | 'nightly_count_mismatch'
  | 'nights_mismatch'
  | 'nightly_subtotal_mismatch'
  | 'quote_total_mismatch';

export interface QuoteSnapshotValidationError {
  readonly field: string;
  readonly code: QuoteSnapshotValidationCode;
  readonly message: string;
}

export type QuoteSnapshotResult = Result<QuoteBreakdown, QuoteSnapshotValidationError>;

const QUOTE_FIELDS = [
  'arrival',
  'departure',
  'nights',
  'currency',
  'nightly',
  'nightlySubtotalMinor',
  'cleaningFeeMinor',
  'totalMinor',
  'minimumStayNights',
] as const;

const MAX_QUOTE_NIGHT_ENTRIES = 3660;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(
  field: string,
  code: QuoteSnapshotValidationCode,
  message: string,
): QuoteSnapshotValidationError {
  return { field, code, message };
}

function isSafeMinorAmount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
  );
}

function isSafeQuoteTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function dateAtOffset(interval: { readonly arrival: string }, offset: number): string {
  const date = new Date(`${interval.arrival}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Validates and clones a quote produced by the server rate boundary. The returned value is
 * the only quote shape that persistence code should treat as a snapshot.
 */
export function createQuoteSnapshot(input: unknown): QuoteSnapshotResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [error('quote', 'invalid_quote', 'quote must be an object.')],
    };
  }

  const errors: QuoteSnapshotValidationError[] = [];
  if (
    Object.keys(input).length !== QUOTE_FIELDS.length ||
    QUOTE_FIELDS.some((field) => !Object.hasOwn(input, field))
  ) {
    errors.push(error('quote', 'invalid_quote', 'quote has an unexpected field set.'));
  }

  const interval = createLocalDateInterval({
    arrival: input['arrival'],
    departure: input['departure'],
  });
  if (!interval.ok) {
    errors.push(error('interval', 'invalid_quote', 'quote interval is invalid.'));
  }

  const currency = input['currency'];
  if (
    typeof currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(currency) ||
    !ISO_4217_ACTIVE_CODES.has(currency)
  ) {
    errors.push(error('currency', 'invalid_currency', 'quote currency is not active.'));
  }

  const nights = input['nights'];
  if (!Number.isSafeInteger(nights) || typeof nights !== 'number' || nights < 1 || nights > 3660) {
    errors.push(error('nights', 'invalid_quote', 'quote nights are outside the bounded range.'));
  }
  if (interval.ok && typeof nights === 'number' && nights !== interval.value.nights) {
    errors.push(error('nights', 'nights_mismatch', 'quote nights must match the quote interval.'));
  }

  const minimumStayNights = input['minimumStayNights'];
  if (
    !Number.isSafeInteger(minimumStayNights) ||
    typeof minimumStayNights !== 'number' ||
    minimumStayNights < 1 ||
    minimumStayNights > 3660
  ) {
    errors.push(
      error(
        'minimumStayNights',
        'invalid_quote',
        'quote minimum stay is outside the bounded range.',
      ),
    );
  }

  const cleaningFeeMinor = input['cleaningFeeMinor'];
  if (!isSafeMinorAmount(cleaningFeeMinor)) {
    errors.push(error('cleaningFeeMinor', 'invalid_amount', 'cleaning fee is not bounded.'));
  }
  const validCleaningFeeMinor = isSafeMinorAmount(cleaningFeeMinor) ? cleaningFeeMinor : undefined;

  const nightlyInput = input['nightly'];
  const nightly: QuoteNight[] = [];
  let nightlySubtotalMinor = 0;
  if (!Array.isArray(nightlyInput)) {
    errors.push(error('nightly', 'invalid_quote', 'nightly must be an array.'));
  } else if (nightlyInput.length > MAX_QUOTE_NIGHT_ENTRIES) {
    errors.push(
      error(
        'nightly',
        'invalid_quote',
        `nightly must contain at most ${MAX_QUOTE_NIGHT_ENTRIES} entries.`,
      ),
    );
  } else {
    if (typeof nights === 'number' && nightlyInput.length !== nights) {
      errors.push(error('nightly', 'nightly_count_mismatch', 'nightly count must equal nights.'));
    }
    for (const [index, rawNight] of nightlyInput.entries()) {
      if (!isRecord(rawNight)) {
        errors.push(
          error(`nightly[${index}]`, 'invalid_nightly_entry', 'nightly entry must be an object.'),
        );
        continue;
      }
      const date = rawNight['date'];
      const amountMinor = rawNight['amountMinor'];
      const source = rawNight['source'];
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !isSafeMinorAmount(amountMinor) ||
        (source !== 'base' && source !== 'seasonal_override') ||
        Object.keys(rawNight).length !== 3
      ) {
        errors.push(
          error(`nightly[${index}]`, 'invalid_nightly_entry', 'nightly entry is not bounded.'),
        );
        continue;
      }
      if (interval.ok && date !== dateAtOffset(interval.value, index)) {
        errors.push(
          error(
            `nightly[${index}].date`,
            'invalid_nightly_entry',
            'nightly dates are not contiguous.',
          ),
        );
      }
      nightlySubtotalMinor += amountMinor;
      nightly.push(Object.freeze({ date, amountMinor, source }));
    }
  }

  const expectedNightlySubtotal = input['nightlySubtotalMinor'];
  if (
    !isSafeQuoteTotal(expectedNightlySubtotal) ||
    expectedNightlySubtotal !== nightlySubtotalMinor
  ) {
    errors.push(
      error(
        'nightlySubtotalMinor',
        'nightly_subtotal_mismatch',
        'nightlySubtotalMinor must equal the nightly amounts.',
      ),
    );
  }
  const totalMinor = input['totalMinor'];
  if (
    !isSafeQuoteTotal(totalMinor) ||
    validCleaningFeeMinor === undefined ||
    totalMinor !== nightlySubtotalMinor + validCleaningFeeMinor
  ) {
    errors.push(
      error(
        'totalMinor',
        'quote_total_mismatch',
        'totalMinor must equal subtotal plus cleaning fee.',
      ),
    );
  }

  if (errors.length > 0 || !interval.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: Object.freeze({
      arrival: interval.value.arrival,
      departure: interval.value.departure,
      nights: interval.value.nights,
      currency: currency as string,
      nightly: Object.freeze(nightly),
      nightlySubtotalMinor,
      cleaningFeeMinor: validCleaningFeeMinor as number,
      totalMinor: totalMinor as number,
      minimumStayNights: minimumStayNights as number,
    }),
  };
}
