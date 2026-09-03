import type { ServerResponse } from 'node:http';

import type { AdminHttpResponse } from '../admin/api.js';

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

export function writeAdminResponse(response: ServerResponse, result: AdminHttpResponse): void {
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

export function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function defaultErrorBody(): {
  readonly error: { readonly code: 'internal_error'; readonly message: string };
} {
  return {
    error: {
      code: 'internal_error',
      message: 'The public API could not complete the request.',
    },
  };
}
