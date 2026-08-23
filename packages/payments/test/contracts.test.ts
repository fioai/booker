import { describe, expect, it } from 'vitest';

import {
  createPaymentCheckoutRequestV1,
  paymentStateTransitionV1,
  type MoneyMinor,
  type PaymentCheckoutRequestV1,
} from '../src/index.js';

const validInput = {
  organizationId: 'org-a',
  propertyId: 'property-a',
  requestId: 'request-a',
  holdId: 'hold-a',
  amountMinor: 28_500 as MoneyMinor,
  currency: 'EUR',
  quoteRevision: 'quote-sha256-a',
  checkoutExpiresAt: '2026-08-01T00:15:00.000Z',
};

describe('provider-neutral payment contracts', () => {
  it('canonicalizes a bounded server-owned checkout request', () => {
    const result = createPaymentCheckoutRequestV1(validInput);

    expect(result).toEqual({ ok: true, value: validInput });
    if (!result.ok) {
      throw new Error('expected valid payment checkout request');
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.amountMinor).toBe(28_500);
    expect(result.value.currency).toBe('EUR');
  });

  it.each([
    ['amountMinor', { amountMinor: -1 }],
    ['currency', { currency: 'eur' }],
    ['organizationId', { organizationId: 'org with spaces' }],
    ['quoteRevision', { quoteRevision: 'private quote text' }],
  ])('rejects an invalid server-owned checkout field: %s', (_field, change) => {
    const result = createPaymentCheckoutRequestV1({ ...validInput, ...change });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected invalid payment checkout request');
    }
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).not.toContain('private');
  });

  it('allows a paid state to remain paid and rejects regressions from terminal states', () => {
    expect(paymentStateTransitionV1('open', 'succeeded')).toEqual({ ok: true, value: 'paid' });
    expect(paymentStateTransitionV1('paid', 'failed')).toEqual({ ok: true, value: 'paid' });
    expect(paymentStateTransitionV1('expired', 'succeeded')).toMatchObject({
      ok: false,
      error: { code: 'terminal_state' },
    });
  });

  it('keeps the public request type provider-neutral', () => {
    const request: PaymentCheckoutRequestV1 = validInput;
    expect('stripe' in request).toBe(false);
  });
});
