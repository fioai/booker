import type { IncomingMessage } from 'node:http';

export const MAX_JSON_BODY_BYTES = 1_048_576;
export const MAX_PAYMENT_WEBHOOK_BODY_BYTES = 262_144;

export function readJsonBody(request: IncomingMessage, allowFormEncoded = false): Promise<unknown> {
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

export function readRawBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
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
