import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  PUBLIC_BOOKING_OPENAPI_PATH_V1,
  PUBLIC_BOOKING_OPENAPI_V1,
} from '@lotus-booking/sdk-typescript';

import {
  createPublicBookingHttpApiV1,
  type PublicBookingApiDependenciesV1,
  type PublicBookingScopeV1,
} from './public-booking-api.js';
import {
  createAdminHttpApiV1,
  type AdminHttpApiDependenciesV1,
  type AdminHttpApiOptionsV1,
  type AdminHttpResponseV1,
} from './admin-api.js';
import { createPaymentHttpApiV1 } from './payment-http-api.js';
import type { PaymentCheckoutServiceV1 } from '@lotus-booking/payments';

const MAX_JSON_BODY_BYTES = 1_048_576;
const MAX_PAYMENT_WEBHOOK_BODY_BYTES = 262_144;

export interface PublicBookingHttpServerOptionsV1 {
  /** Public consumers use this fixed composition-time organization scope. */
  readonly scope: PublicBookingScopeV1;
  /** Optional same-origin owner administration mounted on the same HTTP boundary. */
  readonly admin?: {
    readonly dependencies: AdminHttpApiDependenciesV1;
    readonly options?: AdminHttpApiOptionsV1;
  };
  /** Optional provider-neutral payment composition with a bounded webhook adapter. */
  readonly payments?: PaymentCheckoutServiceV1;
}

export interface PublicBookingHttpServerAddressV1 {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface PublicBookingHttpServerV1 {
  readonly server: Server;
  listen(port?: number, host?: string): Promise<PublicBookingHttpServerAddressV1>;
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
    return new URL(path, 'http://lotus-booking.invalid').pathname;
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

function writeAdminResponse(response: ServerResponse, result: AdminHttpResponseV1): void {
  response.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value);
  }
  if (result.status === 204 || result.body === undefined) {
    response.end();
    return;
  }
  if (typeof result.body === 'string') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('content-length', Buffer.byteLength(result.body));
    response.end(result.body);
    return;
  }
  const payload = JSON.stringify(result.body);
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

function readJsonBody(request: IncomingMessage, allowFormEncoded = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let payload = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_JSON_BODY_BYTES) {
        payload += chunk;
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_JSON_BODY_BYTES || payload.trim().length === 0) {
        resolve(undefined);
        return;
      }
      const contentType = request.headers['content-type']?.toLowerCase() ?? '';
      if (allowFormEncoded && contentType.startsWith('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(payload).entries()));
        return;
      }
      try {
        resolve(JSON.parse(payload) as unknown);
      } catch {
        resolve(undefined);
      }
    });
  });
}

function readRawBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size <= MAX_PAYMENT_WEBHOOK_BODY_BYTES) {
        chunks.push(bytes);
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      resolve(size > MAX_PAYMENT_WEBHOOK_BODY_BYTES ? undefined : Buffer.concat(chunks, size));
    });
  });
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function defaultErrorBody(): {
  readonly error: { readonly code: 'internal_error'; readonly message: string };
} {
  return {
    error: {
      code: 'internal_error',
      message: 'The public API could not complete the request.',
    },
  };
}

/**
 * Binds the public API to a real HTTP server without adding a framework dependency.
 * The supplied scope is intentionally composition-time context for this slice.
 */
export function createPublicBookingHttpServerV1(
  dependencies: PublicBookingApiDependenciesV1,
  options: PublicBookingHttpServerOptionsV1,
): PublicBookingHttpServerV1 {
  const httpApi = createPublicBookingHttpApiV1(dependencies);
  const adminApi =
    options.admin === undefined
      ? undefined
      : createAdminHttpApiV1(options.admin.dependencies, options.admin.options);
  const paymentApi =
    options.payments === undefined
      ? undefined
      : createPaymentHttpApiV1(options.payments, { scope: options.scope });
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
    listen(port = 0, host = '127.0.0.1'): Promise<PublicBookingHttpServerAddressV1> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('Public booking HTTP server did not expose a TCP address.'));
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
