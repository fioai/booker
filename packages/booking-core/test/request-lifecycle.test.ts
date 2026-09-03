import { describe, expect, it } from 'vitest';

import {
  createQuoteSnapshot,
  transitionBookingRequest,
  type QuoteBreakdown,
} from '../src/index.js';

const quote: QuoteBreakdown = {
  arrival: '2026-08-01',
  departure: '2026-08-03',
  nights: 2,
  currency: 'EUR',
  nightly: [
    { date: '2026-08-01', amountMinor: 12500, source: 'base' },
    { date: '2026-08-02', amountMinor: 12500, source: 'base' },
  ],
  nightlySubtotalMinor: 25000,
  cleaningFeeMinor: 3500,
  totalMinor: 28500,
  minimumStayNights: 2,
};

describe('request lifecycle domain', () => {
  it('allows only pending approval, rejection, or expiry transitions', () => {
    expect(transitionBookingRequest('pending', 'approve')).toEqual({
      ok: true,
      value: 'approved',
    });
    expect(transitionBookingRequest('pending', 'reject')).toEqual({
      ok: true,
      value: 'rejected',
    });
    expect(transitionBookingRequest('pending', 'expire')).toEqual({
      ok: true,
      value: 'expired',
    });
  });

  it('reports illegal transitions without returning a next state', () => {
    expect(transitionBookingRequest('approved', 'reject')).toEqual({
      ok: false,
      errors: [
        {
          code: 'illegal_transition',
          from: 'approved',
          action: 'reject',
        },
      ],
    });
    expect(transitionBookingRequest('expired', 'approve')).toMatchObject({
      ok: false,
      errors: [{ code: 'illegal_transition' }],
    });
    expect(transitionBookingRequest('pending', 'unexpected' as never)).toMatchObject({
      ok: false,
      errors: [{ code: 'illegal_transition', from: 'pending' }],
    });
  });

  it('creates an immutable, internally consistent server quote snapshot', () => {
    const result = createQuoteSnapshot(quote);

    expect(result).toEqual({ ok: true, value: quote });
    if (!result.ok) {
      throw new Error('quote fixture must be valid');
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.nightly)).toBe(true);
    expect(Object.isFrozen(result.value.nightly[0])).toBe(true);
    expect(() => {
      (result.value as { totalMinor: number }).totalMinor = 1;
    }).toThrow(TypeError);
  });

  it('rejects a quote snapshot that does not match its own bounded totals', () => {
    const result = createQuoteSnapshot({ ...quote, totalMinor: 1 });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ field: 'totalMinor', code: 'quote_total_mismatch' }],
    });
  });

  it('accepts safe multi-night totals above one nightly-rate bound', () => {
    const highValueQuote: QuoteBreakdown = {
      ...quote,
      nightly: [
        { date: '2026-08-01', amountMinor: 600_000_000, source: 'base' },
        { date: '2026-08-02', amountMinor: 600_000_000, source: 'base' },
      ],
      nightlySubtotalMinor: 1_200_000_000,
      cleaningFeeMinor: 3500,
      totalMinor: 1_200_003_500,
    };

    expect(createQuoteSnapshot(highValueQuote)).toMatchObject({
      ok: true,
      value: { nightlySubtotalMinor: 1_200_000_000, totalMinor: 1_200_003_500 },
    });
  });

  it('rejects a quote whose declared nights differ from its date interval', () => {
    const result = createQuoteSnapshot({
      ...quote,
      nights: 3,
      nightly: [...quote.nightly, { date: '2026-08-03', amountMinor: 12500, source: 'base' }],
      nightlySubtotalMinor: 37500,
      totalMinor: 41000,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ field: 'nights', code: 'nights_mismatch' }],
    });
  });

  it('rejects a nightly snapshot that exceeds the bounded night-entry count', () => {
    const result = createQuoteSnapshot({
      ...quote,
      nights: 3660,
      departure: '2036-08-08',
      nightly: new Array(3661).fill({
        date: '2026-08-01',
        amountMinor: 1,
        source: 'base',
      }),
      nightlySubtotalMinor: 3661,
      totalMinor: 7161,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('oversized nightly snapshot must be rejected');
    }
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'nightly', code: 'invalid_quote' }),
    );
  });
});
