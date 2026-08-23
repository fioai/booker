import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  createAdminHttpApiV1,
  type AdminHttpApiDependenciesV1,
  type AdminHttpApiOptionsV1,
  type AdminHttpResponseV1,
} from './admin-api.js';

const MAX_ADMIN_JSON_BODY_BYTES = 256 * 1_024;

export interface AdminHttpServerOptionsV1 extends AdminHttpApiOptionsV1 {
  readonly dependencies: AdminHttpApiDependenciesV1;
}

export interface AdminHttpServerAddressV1 {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface AdminHttpServerV1 {
  readonly server: Server;
  listen(port?: number, host?: string): Promise<AdminHttpServerAddressV1>;
  close(): Promise<void>;
}

function headers(request: IncomingMessage): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      result[name.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[name.toLowerCase()] = value.join(',');
    }
  }
  return result;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isSafeInteger(contentLength) && contentLength > MAX_ADMIN_JSON_BODY_BYTES) {
      request.resume();
      resolve(undefined);
      return;
    }
    let size = 0;
    let payload = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_ADMIN_JSON_BODY_BYTES) {
        payload += chunk;
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_ADMIN_JSON_BODY_BYTES || payload.trim().length === 0) {
        resolve(undefined);
        return;
      }
      const contentType = request.headers['content-type']?.toLowerCase() ?? '';
      if (contentType.startsWith('application/x-www-form-urlencoded')) {
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

function writeResponse(response: ServerResponse, result: AdminHttpResponseV1): void {
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

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function createAdminHttpServerV1(options: AdminHttpServerOptionsV1): AdminHttpServerV1;
export function createAdminHttpServerV1(
  dependencies: AdminHttpApiDependenciesV1,
  options?: AdminHttpApiOptionsV1,
): AdminHttpServerV1;
export function createAdminHttpServerV1(
  dependenciesOrOptions: AdminHttpServerOptionsV1 | AdminHttpApiDependenciesV1,
  options: AdminHttpApiOptionsV1 = {},
): AdminHttpServerV1 {
  const resolvedOptions: AdminHttpServerOptionsV1 =
    'dependencies' in dependenciesOrOptions
      ? dependenciesOrOptions
      : { ...options, dependencies: dependenciesOrOptions };
  const api = createAdminHttpApiV1(resolvedOptions.dependencies, resolvedOptions);
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const body = hasBody ? await readBody(request) : (request.resume(), undefined);
      const result = await api.handle({
        method,
        path: request.url ?? '/admin',
        headers: headers(request),
        ...(body === undefined ? {} : { body }),
      });
      writeResponse(response, result);
    })().catch(() => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          error: { code: 'internal_error', message: 'The admin request could not be completed.' },
        }),
      );
    });
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1'): Promise<AdminHttpServerAddressV1> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('Admin HTTP server did not expose a TCP address.'));
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
