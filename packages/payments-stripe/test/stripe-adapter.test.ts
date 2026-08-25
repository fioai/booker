import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { PaymentCheckoutRequest } from '../../payments/src/index.js';
import {
  StripeWebhookError,
  createStripeCheckoutAdapter,
  verifyStripeWebhookSignature,
} from '../src/index.js';

const secret = 'whsec_test_only_secret';
const now = new Date('2026-08-01T00:00:00.000Z');
const checkoutRequest = {
  organizationId: 'org-a',
  propertyId: 'property-a',
  requestId: 'request-a',
  holdId: 'hold-a',
  amountMinor: 28_500,
  currency: 'EUR',
  quoteRevision: 'quote-sha256-a',
  checkoutExpiresAt: '2026-08-01T00:15:00.000Z',
} as PaymentCheckoutRequest;

function sign(rawBody: Uint8Array, timestamp = Math.floor(now.getTime() / 1000)): string {
  const digest = createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`, 'utf8'))
    .update(rawBody)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function eventBody(overrides: Record<string, unknown> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      id: 'evt_test_001',
      type: 'checkout.session.completed',
      account: 'acct_test_001',
      created: Math.floor(now.getTime() / 1000),
      data: {
        object: {
          id: 'cs_test_001',
          payment_status: 'paid',
          amount_total: 28_500,
          currency: 'eur',
          payment_intent: 'pi_test_001',
          metadata: {
            organization_id: 'org-a',
            property_id: 'property-a',
            request_id: 'request-a',
            hold_id: 'hold-a',
            quote_revision: 'quote-sha256-a',
          },
        },
      },
      ...overrides,
    }),
  );
}

describe('bounded Stripe test-mode adapter', () => {
  it('refuses live mode and live-looking keys', () => {
    expect(() =>
      createStripeCheckoutAdapter({
        mode: 'live' as 'test',
        accountId: 'acct_test_001',
        webhookSecret: secret,
      }),
    ).toThrow('test mode');
    expect(() =>
      createStripeCheckoutAdapter({
        mode: 'test',
        accountId: 'acct_test_001',
        webhookSecret: secret,
        secretKey: 'sk_live_never_allowed',
      }),
    ).toThrow('test mode');
  });

  it('creates a deterministic local test checkout without a provider network call', async () => {
    const adapter = createStripeCheckoutAdapter({
      mode: 'test',
      accountId: 'acct_test_001',
      webhookSecret: secret,
    });

    await expect(adapter.createCheckoutSession(checkoutRequest)).resolves.toEqual({
      providerName: 'stripe',
      providerSessionId: expect.stringMatching(/^cs_test_[a-f0-9]{24}$/u),
      checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\/cs_test_/u),
      expiresAt: checkoutRequest.checkoutExpiresAt,
    });
  });

  it('verifies the exact raw bytes and normalizes a paid Checkout event', () => {
    const adapter = createStripeCheckoutAdapter({
      mode: 'test',
      accountId: 'acct_test_001',
      webhookSecret: secret,
      clock: () => now,
    });
    const raw = eventBody();

    expect(verifyStripeWebhookSignature(raw, sign(raw), secret, { now })).toEqual({
      timestamp: Math.floor(now.getTime() / 1000),
    });
    expect(adapter.verifyWebhook(raw, sign(raw))).toEqual({
      providerName: 'stripe',
      providerEventId: 'evt_test_001',
      providerAccountId: 'acct_test_001',
      eventType: 'succeeded',
      providerSessionId: 'cs_test_001',
      providerPaymentId: 'pi_test_001',
      amountMinor: 28_500,
      currency: 'EUR',
      metadata: {
        organizationId: 'org-a',
        propertyId: 'property-a',
        requestId: 'request-a',
        holdId: 'hold-a',
        quoteRevision: 'quote-sha256-a',
      },
      occurredAt: '2026-08-01T00:00:00.000Z',
    });

    expect(() => adapter.verifyWebhook(Buffer.concat([raw, Buffer.from('\n')]), sign(raw))).toThrow(
      'signature',
    );
  });

  it.each([
    ['invalid signature', 't=1785542400,v1=not-a-digest'],
    ['stale timestamp', `t=${Math.floor(now.getTime() / 1000) - 601},v1=invalid`],
    ['malformed header', 'v1=only'],
  ])('rejects %s without exposing secrets', (_label, header) => {
    const adapter = createStripeCheckoutAdapter({
      mode: 'test',
      accountId: 'acct_test_001',
      webhookSecret: secret,
      clock: () => now,
    });

    expect(() => adapter.verifyWebhook(eventBody(), header)).toThrow(StripeWebhookError);
    try {
      adapter.verifyWebhook(eventBody(), header);
    } catch (error) {
      expect(error).toBeInstanceOf(StripeWebhookError);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('org-a');
    }
  });

  it('rejects an account mismatch and an oversized exact body', () => {
    const adapter = createStripeCheckoutAdapter({
      mode: 'test',
      accountId: 'acct_expected',
      webhookSecret: secret,
      maxBodyBytes: 512,
      clock: () => now,
    });
    const mismatch = eventBody({ account: 'acct_other' });
    expect(() => adapter.verifyWebhook(mismatch, sign(mismatch))).toThrow('account');

    const oversized = Buffer.alloc(513, 0x20);
    expect(() => adapter.verifyWebhook(oversized, sign(oversized))).toThrow('body');
  });

  it('rejects a signed live-mode event in the test-only adapter', () => {
    const adapter = createStripeCheckoutAdapter({
      mode: 'test',
      accountId: 'acct_test_001',
      webhookSecret: secret,
      clock: () => now,
    });
    const liveEvent = eventBody({ livemode: true });

    expect(() => adapter.verifyWebhook(liveEvent, sign(liveEvent))).toThrow('test mode');
  });
});
