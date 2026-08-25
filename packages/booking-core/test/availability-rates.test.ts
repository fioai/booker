import { describe, expect, it } from 'vitest';

import {
  createLocalDateInterval,
  createRatePlan,
  intervalsOverlap,
  quoteRatePlan,
  type RatePlan,
} from '../src/availability-rates.js';

function validInterval(input: { arrival: string; departure: string }) {
  const result = createLocalDateInterval(input);
  if (!result.ok) {
    throw new Error(result.errors.map(({ field, code }) => `${field}:${code}`).join(', '));
  }

  return result.value;
}

function validRatePlan(): RatePlan {
  const result = createRatePlan({
    currency: 'EUR',
    baseNightlyRateMinor: 12_500,
    cleaningFeeMinor: 3_500,
    minimumStayNights: 2,
    seasonalOverrides: [
      {
        arrival: '2026-07-01',
        departure: '2026-07-04',
        nightlyRateMinor: 15_000,
      },
    ],
  });
  if (!result.ok) {
    throw new Error(result.errors.map(({ field, code }) => `${field}:${code}`).join(', '));
  }

  return result.value;
}

describe('bounded property-local booking intervals', () => {
  it('uses strict local calendar dates and half-open adjacency', () => {
    const first = validInterval({ arrival: '2026-03-29', departure: '2026-03-30' });
    const adjacent = validInterval({ arrival: '2026-03-30', departure: '2026-04-02' });

    expect(first.nights).toBe(1);
    expect(intervalsOverlap(first, adjacent)).toBe(false);
    expect(
      intervalsOverlap(first, validInterval({ arrival: '2026-03-29', departure: '2026-03-31' })),
    ).toBe(true);
  });

  it.each([
    [{ arrival: '2026-02-30', departure: '2026-03-01' }, 'arrival:invalid_date'],
    [{ arrival: '2026-04-02', departure: '2026-04-02' }, 'interval:non_positive_length'],
    [{ arrival: '2026-04-03', departure: '2026-04-02' }, 'interval:non_positive_length'],
    [{ arrival: '2026-04-02T00:00:00Z', departure: '2026-04-03' }, 'arrival:invalid_date'],
  ] as const)('rejects invalid or unbounded date input %#', (input, expected) => {
    const result = createLocalDateInterval(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ field, code }) => `${field}:${code}`)).toContain(expected);
    }
  });
});

describe('integer minor-unit rates and quote breakdowns', () => {
  it('prices each local night with a seasonal override and adds cleaning once', () => {
    const quote = quoteRatePlan(
      validRatePlan(),
      validInterval({ arrival: '2026-07-02', departure: '2026-07-06' }),
    );

    expect(quote.ok).toBe(true);
    if (!quote.ok) {
      return;
    }

    expect(quote.value.nights).toBe(4);
    expect(quote.value.nightlySubtotalMinor).toBe(55_000);
    expect(quote.value.cleaningFeeMinor).toBe(3_500);
    expect(quote.value.totalMinor).toBe(58_500);
    expect(quote.value.currency).toBe('EUR');
    expect(quote.value.nightly).toEqual([
      { date: '2026-07-02', amountMinor: 15_000, source: 'seasonal_override' },
      { date: '2026-07-03', amountMinor: 15_000, source: 'seasonal_override' },
      { date: '2026-07-04', amountMinor: 12_500, source: 'base' },
      { date: '2026-07-05', amountMinor: 12_500, source: 'base' },
    ]);
  });

  it('rejects fractional, negative, mismatched, overlapping, and below-minimum values', () => {
    expect(
      createRatePlan({
        currency: 'EUR',
        baseNightlyRateMinor: 12_500.5,
        cleaningFeeMinor: 0,
        minimumStayNights: 1,
        seasonalOverrides: [],
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'baseNightlyRateMinor', code: 'invalid_minor_amount' }],
    });

    expect(
      createRatePlan({
        currency: 'EUR',
        baseNightlyRateMinor: 12_500,
        cleaningFeeMinor: -1,
        minimumStayNights: 1,
        seasonalOverrides: [],
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'cleaningFeeMinor', code: 'negative_minor_amount' }],
    });

    expect(
      createRatePlan({
        currency: 'EUR',
        baseNightlyRateMinor: 12_500,
        cleaningFeeMinor: 0,
        minimumStayNights: 1,
        seasonalOverrides: [
          { arrival: '2026-07-01', departure: '2026-07-03', nightlyRateMinor: 13_000 },
          { arrival: '2026-07-02', departure: '2026-07-04', nightlyRateMinor: 14_000 },
        ],
      }),
    ).toMatchObject({
      ok: false,
      errors: [{ field: 'seasonalOverrides[1]', code: 'overlapping_override' }],
    });

    const quote = quoteRatePlan(
      validRatePlan(),
      validInterval({ arrival: '2026-07-02', departure: '2026-07-03' }),
    );
    expect(quote).toMatchObject({
      ok: false,
      errors: [{ field: 'interval', code: 'minimum_stay' }],
    });
  });
});
