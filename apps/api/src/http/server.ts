import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  PUBLIC_BOOKING_OPENAPI_PATH_V1,
  PUBLIC_BOOKING_OPENAPI_V1,
} from '@booking-engine/sdk-typescript';
import type { PaymentCheckoutService } from '@booking-engine/payments';

import { readJsonBody, readRawBody } from './body.js';
import { defaultErrorBody, hostForUrl, writeAdminResponse, writeJson } from './response.js';
import {
  createPublicBookingHttpApi,
  type PublicBookingApiDependencies,
  type PublicBookingScope,
} from '../public/booking/api.js';
import {
  createAdminHttpApi,
  type AdminHttpApiDependencies,
  type AdminHttpApiOptions,
} from '../admin/api.js';
import { createPaymentHttpApi } from '../payment/http/api.js';

export interface ApiHttpServerOptions {
  /** Public consumers use this fixed composition-time organization scope. */
  readonly scope: PublicBookingScope;
  /** Optional same-origin owner administration mounted on the same HTTP boundary. */
  readonly admin?: {
    readonly dependencies: AdminHttpApiDependencies;
    readonly options?: AdminHttpApiOptions;
  };
  /** Optional provider-neutral payment composition with a bounded webhook adapter. */
  readonly payments?: PaymentCheckoutService;
}

export interface ApiHttpServerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface ApiHttpServer {
  readonly server: Server;
  listen(port?: number, host?: string): Promise<ApiHttpServerAddress>;
  close(): Promise<void>;
}

function requestPath(request: IncomingMessage): string {
  return request.url ?? '/';
}

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      headers[name.toLowerCase()] = value.join(',');
    }
  }
  return headers;
}

function requestPathname(path: string): string | undefined {
  try {
    return new URL(path, 'http://booking-engine.invalid').pathname;
  } catch {
    return undefined;
  }
}

/** Composes public booking, same-origin admin, optional payments, and health on one listener. */
export function createApiHttpServer(
  dependencies: PublicBookingApiDependencies,
  options: ApiHttpServerOptions,
): ApiHttpServer {
  const httpApi = createPublicBookingHttpApi(dependencies);
  const adminApi =
    options.admin === undefined
      ? undefined
      : createAdminHttpApi(options.admin.dependencies, options.admin.options);
  const paymentApi =
    options.payments === undefined
      ? undefined
      : createPaymentHttpApi(options.payments, { scope: options.scope });
  const server = createServer((request, response) => {
    void (async () => {
      const path = requestPath(request);
      const pathname = requestPathname(path);
      if (request.method === 'GET' && pathname === '/healthz') {
        response.setHeader('cache-control', 'no-store');
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && pathname === PUBLIC_BOOKING_OPENAPI_PATH_V1) {
        writeJson(response, 200, PUBLIC_BOOKING_OPENAPI_V1);
        return;
      }

      const headers = requestHeaders(request);
      const isPaymentWebhookRoute = pathname === '/v1/payments/stripe/webhook';
      const isPaymentCheckoutRoute =
        /^\/v1\/properties\/[^/]+\/booking-requests\/[^/]+\/checkout$/u.test(pathname ?? '');
      if (paymentApi !== undefined && (isPaymentWebhookRoute || isPaymentCheckoutRoute)) {
        const rawBody = isPaymentWebhookRoute ? await readRawBody(request) : undefined;
        const body = isPaymentWebhookRoute
          ? undefined
          : request.method === 'POST'
            ? await readJsonBody(request)
            : (request.resume(), undefined);
        const result = await paymentApi.handle({
          method: request.method ?? 'GET',
          path,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(rawBody === undefined ? {} : { rawBody }),
        });
        writeJson(response, result.status, result.body);
        return;
      }
      const isAdminRoute = pathname?.startsWith('/admin/') === true || pathname === '/admin';
      if (isAdminRoute && adminApi !== undefined) {
        const hasBody =
          request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH';
        const body = hasBody ? await readJsonBody(request, true) : (request.resume(), undefined);
        const result = await adminApi.handle({
          method: request.method ?? 'GET',
          path,
          headers,
          ...(body === undefined ? {} : { body }),
        });
        writeAdminResponse(response, result);
        return;
      }

      const body =
        request.method === 'POST' ? await readJsonBody(request) : (request.resume(), undefined);
      const result = await httpApi.handle(options.scope, {
        method: request.method ?? 'GET',
        path,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      writeJson(response, result.status, result.body);
    })().catch(() => {
      writeJson(response, 500, defaultErrorBody());
    });
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1'): Promise<ApiHttpServerAddress> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('API HTTP server did not expose a TCP address.'));
            return;
          }
          resolve({
            host: address.address,
            port: address.port,
            url: `http://${hostForUrl(address.address)}:${address.port}`,
          });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close(): Promise<void> {
      if (!server.listening) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
