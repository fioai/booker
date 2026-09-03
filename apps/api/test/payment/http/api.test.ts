import { describe, expect, it, vi } from 'vitest';

import type { PaymentCheckoutService } from '@booking-engine/payments';

import { createPaymentHttpApi } from '../../../src/payment/http/api.js';

const session = {
  providerName: 'stripe',
  providerSessionId: 'cs_test_http_001',
  checkoutUrl: 'https://checkout.stripe.test/cs_test_http_001',
  expiresAt: '2026-08-01T00:15:00.000Z',
};

describe('payment HTTP boundary', () => {
  it('requires an explicit tenant scope at composition time', () => {
    const service: PaymentCheckoutService = {
      startCheckout: vi.fn(async () => session),
      handleWebhook: vi.fn(async () => ({ status: 'processed' as const, payment: null })),
    };

    expect(() => createPaymentHttpApi(service, { scope: undefined as never })).toThrow(
      'payment HTTP scope is required at composition time.',
    );
  });

  it('derives checkout context from the route and rejects browser-owned payment fields', async () => {
    const startCheckout = vi.fn(async () => session);
    const service: PaymentCheckoutService = {
      startCheckout,
      handleWebhook: vi.fn(async () => ({ status: 'processed' as const, payment: null })),
    };
    const api = createPaymentHttpApi(service, { scope: { organizationId: 'org-a' } });

    await expect(
      api.handle({
        method: 'POST',
        path: '/v1/properties/property-a/booking-requests/request-a/checkout',
        body: { amountMinor: 1, currency: 'USD', organizationId: 'other-org' },
      }),
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'invalid_input' } } });
    expect(startCheckout).not.toHaveBeenCalled();

    await expect(
      api.handle({
        method: 'POST',
        path: '/v1/properties/property-a/booking-requests/request-a/checkout',
      }),
    ).resolves.toEqual({
      status: 201,
      body: {
        provider: 'stripe',
        providerSessionId: session.providerSessionId,
        checkoutUrl: session.checkoutUrl,
        expiresAt: session.expiresAt,
      },
    });
    expect(startCheckout).toHaveBeenCalledWith(
      { organizationId: 'org-a' },
      'property-a',
      'request-a',
    );
  });

  it('forwards exact raw webhook bytes and never returns provider event details', async () => {
    const rawBody = new Uint8Array([123, 34, 101, 118, 101, 110, 116, 34, 58, 49, 125]);
    const handleWebhook = vi.fn(async () => ({ status: 'duplicate' as const, payment: null }));
    const service: PaymentCheckoutService = {
      startCheckout: vi.fn(async () => session),
      handleWebhook,
    };
    const api = createPaymentHttpApi(service, { scope: { organizationId: 'org-a' } });

    await expect(
      api.handle({
        method: 'POST',
        path: '/v1/payments/stripe/webhook',
        headers: { 'stripe-signature': 't=1,v1=test' },
        rawBody,
      }),
    ).resolves.toEqual({ status: 200, body: { received: true } });
    expect(handleWebhook).toHaveBeenCalledWith(rawBody, 't=1,v1=test');
    expect(
      JSON.stringify(await api.handle({ method: 'GET', path: '/v1/payments/stripe/webhook' })),
    ).not.toContain('providerEventId');
  });

  it('maps invalid signatures and unconfigured payment flow to bounded errors', async () => {
    const service: PaymentCheckoutService = {
      startCheckout: vi.fn(async () => {
        throw Object.assign(new Error('private provider detail'), {
          code: 'payment_request_not_approved',
        });
      }),
      handleWebhook: vi.fn(async () => {
        throw Object.assign(new Error('secret and PII'), { code: 'invalid_signature' });
      }),
    };
    const api = createPaymentHttpApi(service, { scope: { organizationId: 'org-a' } });

    await expect(
      api.handle({
        method: 'POST',
        path: '/v1/properties/property-a/booking-requests/request-a/checkout',
      }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: 'payment_unavailable', message: expect.any(String) } },
    });
    await expect(
      api.handle({
        method: 'POST',
        path: '/v1/payments/stripe/webhook',
        headers: { 'stripe-signature': 'bad' },
        rawBody: new Uint8Array([1]),
      }),
    ).resolves.toEqual({
      status: 400,
      body: { error: { code: 'webhook_invalid', message: 'Webhook could not be verified.' } },
    });
  });
});
