import { request } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaymentCheckoutServiceV1 } from '@lotus-booking/payments';

import {
  createPublicBookingHttpServerV1,
  type PublicBookingApiDependenciesV1,
  type PublicBookingHttpServerV1,
} from '../src/index.js';

const publicDependencies: PublicBookingApiDependenciesV1 = {
  properties: { findPublicById: vi.fn(async () => null) },
  availability: { isAvailable: vi.fn(async () => false) },
  rates: {
    quote: vi.fn(async () => {
      throw new Error('unused');
    }),
  },
  bookingRequests: {
    submit: vi.fn(async () => {
      throw new Error('unused');
    }),
  },
};

describe('payment webhook through the real HTTP server', () => {
  let server: PublicBookingHttpServerV1 | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('passes exact raw webhook bytes and the signature header to the payment service', async () => {
    const raw = Buffer.from('{"event":1}\r\n', 'utf8');
    const handleWebhook = vi.fn<PaymentCheckoutServiceV1['handleWebhook']>(async () => ({
      status: 'processed',
      payment: null,
    }));
    const payments: PaymentCheckoutServiceV1 = {
      startCheckout: vi.fn(async () => {
        throw new Error('unused');
      }),
      handleWebhook,
    };
    server = createPublicBookingHttpServerV1(publicDependencies, {
      scope: { organizationId: 'org-a' },
      payments,
    });
    const address = await server.listen(0, '127.0.0.1');

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const requestBody = request(
        `${address.url}/v1/payments/stripe/webhook`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'stripe-signature': 't=1,v1=test',
            'content-length': raw.byteLength,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      requestBody.on('error', reject);
      requestBody.end(raw);
    });

    expect(response).toEqual({ status: 200, body: '{"received":true}' });
    expect(handleWebhook).toHaveBeenCalledTimes(1);
    const call = handleWebhook.mock.calls[0];
    expect(call?.[0]).toEqual(raw);
    expect(call?.[1]).toBe('t=1,v1=test');
  });

  it('uses the composition-time scope for checkout and ignores browser payment fields', async () => {
    const startCheckout = vi.fn<PaymentCheckoutServiceV1['startCheckout']>(async () => ({
      providerName: 'stripe',
      providerSessionId: 'cs_test_server_checkout',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_server_checkout',
      expiresAt: '2026-08-01T00:15:00.000Z',
    }));
    const payments: PaymentCheckoutServiceV1 = {
      startCheckout,
      handleWebhook: vi.fn(async () => ({ status: 'processed' as const, payment: null })),
    };
    server = createPublicBookingHttpServerV1(publicDependencies, {
      scope: { organizationId: 'org-composed' },
      payments,
    });
    const address = await server.listen(0, '127.0.0.1');

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const checkoutRequest = request(
        `${address.url}/v1/properties/property-a/booking-requests/request-a/checkout`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength('{"organizationId":"org-browser"}'),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      checkoutRequest.on('error', reject);
      checkoutRequest.end('{"organizationId":"org-browser"}');
    });

    expect(response).toEqual({
      status: 400,
      body: '{"error":{"code":"invalid_input","message":"Checkout amount and identifiers are server-controlled."}}',
    });
    expect(startCheckout).not.toHaveBeenCalled();

    const validCheckout = request(
      `${address.url}/v1/properties/property-a/booking-requests/request-a/checkout`,
      { method: 'POST', headers: { 'content-length': '0' } },
    );
    const validResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      validCheckout.on('response', (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
      validCheckout.on('error', reject);
      validCheckout.end();
    });

    expect(validResponse.status).toBe(201);
    expect(startCheckout).toHaveBeenCalledWith(
      { organizationId: 'org-composed' },
      'property-a',
      'request-a',
    );
  });
});
