import { describe, expect, it, vi } from 'vitest';

import {
  createPaymentCheckoutService,
  type MoneyMinor,
  type PaymentCheckoutPreparation,
  type PaymentCheckoutRecord,
  type PaymentCheckoutStore,
  type PaymentProvider,
} from '../src/index.js';

const prepared: PaymentCheckoutPreparation = {
  checkoutId: 'checkout-a',
  providerName: 'stripe',
  providerAccountId: 'acct_test_001',
  providerSessionId: null,
  state: 'created',
  request: {
    organizationId: 'org-a',
    propertyId: 'property-a',
    requestId: 'request-a',
    holdId: 'hold-a',
    amountMinor: 28_500 as MoneyMinor,
    currency: 'EUR',
    quoteRevision: 'quote-sha256-a',
    checkoutExpiresAt: '2026-08-01T00:15:00.000Z',
  },
};

const session = {
  providerName: 'stripe',
  providerSessionId: 'cs_test_a',
  checkoutUrl: 'https://checkout.stripe.test/cs_test_a',
  expiresAt: prepared.request.checkoutExpiresAt,
};

describe('provider-neutral payment checkout service', () => {
  it('starts checkout only from store-prepared server context and attaches the returned session', async () => {
    const attach = vi.fn(async () => ({}) as PaymentCheckoutRecord);
    const store: PaymentCheckoutStore = {
      prepareCheckout: vi.fn(async () => prepared),
      attachProviderSession: attach,
      processWebhookEvent: vi.fn(async () => ({ status: 'processed' as const, payment: null })),
    };
    const provider: PaymentProvider = {
      providerName: 'stripe',
      providerAccountId: 'acct_test_001',
      createCheckoutSession: vi.fn(async (request) => {
        expect(request).toBe(prepared.request);
        return session;
      }),
    };
    const service = createPaymentCheckoutService({ store, provider });

    await expect(
      service.startCheckout({ organizationId: 'org-a' }, 'property-a', 'request-a'),
    ).resolves.toEqual(session);
    expect(store.prepareCheckout).toHaveBeenCalledWith(
      { organizationId: 'org-a' },
      'property-a',
      'request-a',
      { providerName: 'stripe', providerAccountId: 'acct_test_001' },
    );
    expect(attach).toHaveBeenCalledWith(
      { organizationId: 'org-a' },
      'property-a',
      'checkout-a',
      session,
    );
    expect('completeFromBrowser' in service).toBe(false);
  });

  it('routes only verified provider events to the transactional store', async () => {
    const processWebhookEvent = vi.fn(async () => ({
      status: 'duplicate' as const,
      payment: null,
    }));
    const store: PaymentCheckoutStore = {
      prepareCheckout: vi.fn(async () => prepared),
      attachProviderSession: vi.fn(async () => ({}) as PaymentCheckoutRecord),
      processWebhookEvent,
    };
    const event = { providerName: 'stripe', providerEventId: 'evt_a' } as never;
    const provider = {
      providerName: 'stripe',
      providerAccountId: 'acct_test_001',
      createCheckoutSession: vi.fn(async () => session),
      verifyWebhook: vi.fn(() => event),
    };
    const service = createPaymentCheckoutService({ store, provider });

    await expect(
      service.handleWebhook(new Uint8Array([1, 2]), 't=1,v1=test'),
    ).resolves.toMatchObject({ status: 'duplicate' });
    expect(provider.verifyWebhook).toHaveBeenCalledWith(new Uint8Array([1, 2]), 't=1,v1=test');
    expect(processWebhookEvent).toHaveBeenCalledWith(event);
  });
});
