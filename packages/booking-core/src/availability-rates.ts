import { ISO_4217_ACTIVE_CODES_V1 } from './iso-4217-active.js';
import type { ResultV1 } from './property-configuration-types.js';

const RATE_PLAN_BRAND_V1: unique symbol = Symbol('RatePlanV1');
const canonicalRatePlansV1 = new WeakSet<object>();

export const AVAILABILITY_RATES_LIMITS_V1 = Object.freeze({
  minimumYear: 1,
  maximumYear: 9999,
  maximumNights: 3660,
  maximumSeasonalOverrides: 64,
  maximumMinimumStayNights: 3660,
  maximumMinorAmount: 1_000_000_000,
});

export interface LocalDateIntervalInputV1 {
  readonly arrival: string;
  readonly departure: string;
}

export interface LocalDateIntervalV1 {
  readonly arrival: string;
  readonly departure: string;
  readonly nights: number;
}

export type AvailabilityRatesValidationErrorCodeV1 =
  | 'invalid_input'
  | 'missing_field'
  | 'invalid_date'
  | 'non_positive_length'
  | 'interval_too_long'
  | 'invalid_currency'
  | 'unsupported_currency'
  | 'invalid_minor_amount'
  | 'negative_minor_amount'
  | 'minor_amount_too_large'
  | 'invalid_minimum_stay'
  | 'seasonal_overrides_too_many'
  | 'invalid_array'
  | 'overlapping_override'
  | 'minimum_stay'
  | 'quote_total_too_large';

export interface AvailabilityRatesValidationErrorV1 {
  readonly field: string;
  readonly code: AvailabilityRatesValidationErrorCodeV1;
  readonly message: string;
}

export type AvailabilityRatesResultV1<T> = ResultV1<T, AvailabilityRatesValidationErrorV1>;

export interface SeasonalRateOverrideInputV1 {
  readonly arrival: string;
  readonly departure: string;
  readonly nightlyRateMinor: number;
}

export interface SeasonalRateOverrideV1 extends SeasonalRateOverrideInputV1 {
  readonly interval: LocalDateIntervalV1;
}

export interface RatePlanInputV1 {
  readonly currency: string;
  readonly baseNightlyRateMinor: number;
  readonly cleaningFeeMinor: number;
  readonly minimumStayNights: number;
  readonly seasonalOverrides?: readonly SeasonalRateOverrideInputV1[];
}

export interface RatePlanV1 extends RatePlanInputV1 {
  readonly [RATE_PLAN_BRAND_V1]: typeof RATE_PLAN_BRAND_V1;
  readonly currency: string;
  readonly seasonalOverrides: readonly SeasonalRateOverrideV1[];
}

export type QuoteNightSourceV1 = 'base' | 'seasonal_override';

export interface QuoteNightV1 {
  readonly date: string;
  readonly amountMinor: number;
  readonly source: QuoteNightSourceV1;
}

export interface QuoteBreakdownV1 {
  readonly arrival: string;
  readonly departure: string;
  readonly nights: number;
  readonly currency: string;
  readonly nightly: readonly QuoteNightV1[];
  readonly nightlySubtotalMinor: number;
  readonly cleaningFeeMinor: number;
  readonly totalMinor: number;
  readonly minimumStayNights: number;
}

interface ParsedLocalDateV1 {
  readonly text: string;
  readonly dayNumber: number;
}

function success<T>(value: T): AvailabilityRatesResultV1<T> {
  return { ok: true, value };
}

function failure<T = never>(
  errors: readonly AvailabilityRatesValidationErrorV1[],
): AvailabilityRatesResultV1<T> {
  return { ok: false, errors };
}

function validationError(
  field: string,
  code: AvailabilityRatesValidationErrorCodeV1,
  message: string,
): AvailabilityRatesValidationErrorV1 {
  return { field, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Proleptic Gregorian day arithmetic keeps dates independent of the host timezone.
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

function civilFromDays(dayNumber: number): { year: number; month: number; day: number } {
  const era = Math.floor(dayNumber / 146097);
  const dayOfEra = dayNumber - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function dateAtOffset(interval: LocalDateIntervalV1, offset: number): string {
  const year = Number(interval.arrival.slice(0, 4));
  const month = Number(interval.arrival.slice(5, 7));
  const day = Number(interval.arrival.slice(8, 10));
  const date = civilFromDays(daysFromCivil(year, month, day) + offset);
  return formatDate(date.year, date.month, date.day);
}

function parseLocalDate(
  value: unknown,
  field: string,
  errors: AvailabilityRatesValidationErrorV1[],
): ParsedLocalDateV1 | undefined {
  if (value === undefined) {
    errors.push(validationError(field, 'missing_field', `${field} is required.`));
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    errors.push(
      validationError(field, 'invalid_date', `${field} must be a YYYY-MM-DD local calendar date.`),
    );
    return undefined;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (
    year < AVAILABILITY_RATES_LIMITS_V1.minimumYear ||
    year > AVAILABILITY_RATES_LIMITS_V1.maximumYear ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    errors.push(validationError(field, 'invalid_date', `${field} is not a valid Gregorian date.`));
    return undefined;
  }

  return { text: value, dayNumber: daysFromCivil(year, month, day) };
}

function parseInterval(
  input: unknown,
  fieldPrefix = '',
): AvailabilityRatesResultV1<LocalDateIntervalV1> {
  const errors: AvailabilityRatesValidationErrorV1[] = [];
  if (!isRecord(input)) {
    return failure([
      validationError(
        fieldPrefix ? `${fieldPrefix}interval` : 'interval',
        'invalid_input',
        'interval must be an object with arrival and departure dates.',
      ),
    ]);
  }

  const arrival = parseLocalDate(input['arrival'], `${fieldPrefix}arrival`, errors);
  const departure = parseLocalDate(input['departure'], `${fieldPrefix}departure`, errors);
  if (arrival === undefined || departure === undefined) {
    return failure(errors);
  }
  if (arrival.dayNumber >= departure.dayNumber) {
    errors.push(
      validationError(
        fieldPrefix ? `${fieldPrefix}interval` : 'interval',
        'non_positive_length',
        'departure must be after arrival.',
      ),
    );
    return failure(errors);
  }

  const nights = departure.dayNumber - arrival.dayNumber;
  if (nights > AVAILABILITY_RATES_LIMITS_V1.maximumNights) {
    return failure([
      validationError(
        fieldPrefix ? `${fieldPrefix}interval` : 'interval',
        'interval_too_long',
        `interval must be at most ${AVAILABILITY_RATES_LIMITS_V1.maximumNights} nights.`,
      ),
    ]);
  }

  return success(Object.freeze({ arrival: arrival.text, departure: departure.text, nights }));
}

export function createLocalDateIntervalV1(
  input: unknown,
): AvailabilityRatesResultV1<LocalDateIntervalV1> {
  return parseInterval(input);
}

export function intervalsOverlapV1(
  left: Pick<LocalDateIntervalV1, 'arrival' | 'departure'>,
  right: Pick<LocalDateIntervalV1, 'arrival' | 'departure'>,
): boolean {
  return left.arrival < right.departure && right.arrival < left.departure;
}

function readCurrency(
  value: unknown,
  errors: AvailabilityRatesValidationErrorV1[],
): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/u.test(value.trim())) {
    errors.push(
      validationError('currency', 'invalid_currency', 'currency must be a three-letter ISO code.'),
    );
    return undefined;
  }
  const currency = value.trim().toUpperCase();
  if (!ISO_4217_ACTIVE_CODES_V1.has(currency)) {
    errors.push(validationError('currency', 'unsupported_currency', 'currency is not active.'));
    return undefined;
  }
  return currency;
}

function readMinorAmount(
  value: unknown,
  field: string,
  errors: AvailabilityRatesValidationErrorV1[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    errors.push(
      validationError(
        field,
        'invalid_minor_amount',
        `${field} must be a safe integer minor amount.`,
      ),
    );
    return undefined;
  }
  if (value < 0) {
    errors.push(validationError(field, 'negative_minor_amount', `${field} must not be negative.`));
    return undefined;
  }
  if (value > AVAILABILITY_RATES_LIMITS_V1.maximumMinorAmount) {
    errors.push(
      validationError(
        field,
        'minor_amount_too_large',
        `${field} must be at most ${AVAILABILITY_RATES_LIMITS_V1.maximumMinorAmount}.`,
      ),
    );
    return undefined;
  }
  return value;
}

export function createRatePlanV1(input: unknown): AvailabilityRatesResultV1<RatePlanV1> {
  if (!isRecord(input)) {
    return failure([validationError('ratePlan', 'invalid_input', 'rate plan must be an object.')]);
  }

  const errors: AvailabilityRatesValidationErrorV1[] = [];
  const currency = readCurrency(input['currency'], errors);
  const baseNightlyRateMinor = readMinorAmount(
    input['baseNightlyRateMinor'],
    'baseNightlyRateMinor',
    errors,
  );
  const cleaningFeeMinor = readMinorAmount(input['cleaningFeeMinor'], 'cleaningFeeMinor', errors);
  const minimumStayNights = input['minimumStayNights'];
  if (
    typeof minimumStayNights !== 'number' ||
    !Number.isSafeInteger(minimumStayNights) ||
    minimumStayNights < 1 ||
    minimumStayNights > AVAILABILITY_RATES_LIMITS_V1.maximumMinimumStayNights
  ) {
    errors.push(
      validationError(
        'minimumStayNights',
        'invalid_minimum_stay',
        `minimumStayNights must be an integer from 1 to ${AVAILABILITY_RATES_LIMITS_V1.maximumMinimumStayNights}.`,
      ),
    );
  }

  const rawOverrides = input['seasonalOverrides'] ?? [];
  if (!Array.isArray(rawOverrides)) {
    errors.push(
      validationError('seasonalOverrides', 'invalid_array', 'seasonalOverrides must be an array.'),
    );
  } else if (rawOverrides.length > AVAILABILITY_RATES_LIMITS_V1.maximumSeasonalOverrides) {
    errors.push(
      validationError(
        'seasonalOverrides',
        'seasonal_overrides_too_many',
        `seasonalOverrides must contain at most ${AVAILABILITY_RATES_LIMITS_V1.maximumSeasonalOverrides} entries.`,
      ),
    );
  }

  const overrides: SeasonalRateOverrideV1[] = [];
  if (
    Array.isArray(rawOverrides) &&
    rawOverrides.length <= AVAILABILITY_RATES_LIMITS_V1.maximumSeasonalOverrides
  ) {
    for (let index = 0; index < rawOverrides.length; index += 1) {
      const rawOverride = rawOverrides[index];
      if (!isRecord(rawOverride)) {
        errors.push(
          validationError(
            `seasonalOverrides[${index}]`,
            'invalid_input',
            'seasonal override must be an object.',
          ),
        );
        continue;
      }

      const intervalResult = parseInterval(rawOverride, `seasonalOverrides[${index}].`);
      if (!intervalResult.ok) {
        errors.push(...intervalResult.errors);
        continue;
      }
      const nightlyRateMinor = readMinorAmount(
        rawOverride['nightlyRateMinor'],
        `seasonalOverrides[${index}].nightlyRateMinor`,
        errors,
      );
      if (nightlyRateMinor === undefined) {
        continue;
      }

      const override = Object.freeze({
        arrival: intervalResult.value.arrival,
        departure: intervalResult.value.departure,
        nightlyRateMinor,
        interval: intervalResult.value,
      });
      if (overrides.some((existing) => intervalsOverlapV1(existing.interval, override.interval))) {
        errors.push(
          validationError(
            `seasonalOverrides[${index}]`,
            'overlapping_override',
            'seasonal override intervals must not overlap.',
          ),
        );
      }
      overrides.push(override);
    }
  }

  if (
    errors.length > 0 ||
    currency === undefined ||
    baseNightlyRateMinor === undefined ||
    cleaningFeeMinor === undefined ||
    typeof minimumStayNights !== 'number' ||
    !Number.isSafeInteger(minimumStayNights) ||
    minimumStayNights < 1 ||
    minimumStayNights > AVAILABILITY_RATES_LIMITS_V1.maximumMinimumStayNights
  ) {
    return failure(errors);
  }

  const ratePlan = Object.freeze({
    [RATE_PLAN_BRAND_V1]: RATE_PLAN_BRAND_V1,
    currency,
    baseNightlyRateMinor,
    cleaningFeeMinor,
    minimumStayNights,
    seasonalOverrides: Object.freeze(overrides),
  }) as RatePlanV1;
  canonicalRatePlansV1.add(ratePlan);
  return success(ratePlan);
}

export function quoteRatePlanV1(
  ratePlan: RatePlanV1,
  input: unknown,
): AvailabilityRatesResultV1<QuoteBreakdownV1> {
  const intervalResult = createLocalDateIntervalV1(input);
  if (!intervalResult.ok) {
    return failure(intervalResult.errors);
  }
  const interval = intervalResult.value;
  if (interval.nights < ratePlan.minimumStayNights) {
    return failure([
      validationError(
        'interval',
        'minimum_stay',
        `stay must be at least ${ratePlan.minimumStayNights} nights.`,
      ),
    ]);
  }

  const nightly: QuoteNightV1[] = [];
  let nightlySubtotalMinor = 0;
  for (let offset = 0; offset < interval.nights; offset += 1) {
    const date = dateAtOffset(interval, offset);
    const override = ratePlan.seasonalOverrides.find(
      (candidate) => candidate.arrival <= date && date < candidate.departure,
    );
    const amountMinor = override?.nightlyRateMinor ?? ratePlan.baseNightlyRateMinor;
    if (nightlySubtotalMinor > Number.MAX_SAFE_INTEGER - amountMinor) {
      return failure([
        validationError(
          'quote',
          'quote_total_too_large',
          'quote totals must remain safe integer minor amounts.',
        ),
      ]);
    }
    nightlySubtotalMinor += amountMinor;
    nightly.push(
      Object.freeze({
        date,
        amountMinor,
        source: override === undefined ? 'base' : 'seasonal_override',
      }),
    );
  }

  const subtotalWithCleaning = nightlySubtotalMinor + ratePlan.cleaningFeeMinor;
  if (subtotalWithCleaning > Number.MAX_SAFE_INTEGER) {
    return failure([
      validationError(
        'quote',
        'quote_total_too_large',
        'quote totals must remain safe integer minor amounts.',
      ),
    ]);
  }

  return success(
    Object.freeze({
      arrival: interval.arrival,
      departure: interval.departure,
      nights: interval.nights,
      currency: ratePlan.currency,
      nightly: Object.freeze(nightly),
      nightlySubtotalMinor,
      cleaningFeeMinor: ratePlan.cleaningFeeMinor,
      totalMinor: subtotalWithCleaning,
      minimumStayNights: ratePlan.minimumStayNights,
    }),
  );
}

export function isRatePlanV1(value: unknown): value is RatePlanV1 {
  return isRecord(value) && canonicalRatePlansV1.has(value);
}
