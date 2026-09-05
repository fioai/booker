import { createServer, request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCabinDemoServer } from '../../examples/cabin/server.mjs';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('No listener'));
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

describe('local cabin demo boundary', () => {
  let upstream: Server;
  let demo: Server;
  let origin: string;
  let upstreamOrigin: string;
  let forwarded = 0;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      forwarded += 1;
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'demo_cookie=sample; HttpOnly; SameSite=Strict');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () =>
        res.end(
          JSON.stringify({
            method: req.method,
            path: req.url,
            origin: req.headers.origin,
            csrf: req.headers['x-csrf-token'],
            cookie: req.headers.cookie,
            key: req.headers['idempotency-key'],
            body: Buffer.concat(chunks).toString(),
          }),
        ),
      );
    });
    const upstreamPort = await listen(upstream);
    upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    demo = await createCabinDemoServer(upstreamPort);
    origin = `http://127.0.0.1:${await listen(demo)}`;
  });

  afterAll(async () => {
    await close(demo);
    await close(upstream);
  });

  it('serves only declared assets and built public SDK JavaScript', async () => {
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Juniper Cabin');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const sdk = await fetch(`${origin}/sdk/index.js`);
    expect(sdk.headers.get('content-type')).toContain('text/javascript');
    expect((await sdk.text()).length).toBeGreaterThan(0);
    for (const path of [
      '/.env',
      '/server.mjs',
      '/sdk/index.d.ts',
      '/.git/config',
      '/%2e%2e/package.json',
    ]) {
      expect((await fetch(origin + path)).status, path).toBe(404);
    }
    expect((await fetch(origin, { method: 'POST' })).status).toBe(405);
    const head = await fetch(origin, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('rejects untrusted origins and DNS-rebinding hosts before forwarding anything', async () => {
    const before = forwarded;
    const forbidden = await fetch(`${origin}/admin/login`, {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example.test' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(origin, { headers: { Host: 'untrusted.example.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(forwarded).toBe(before);
  });

  it('preserves mutation bodies, CSRF, cookies and idempotency while translating the validated origin', async () => {
    const body = JSON.stringify({ guestName: 'Sample Guest' });
    const response = await fetch(`${origin}/admin/login`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'sample-csrf',
        Cookie: 'demo_cookie=sample',
        'Idempotency-Key': 'sample-request',
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/admin/login',
      origin: upstreamOrigin,
      csrf: 'sample-csrf',
      cookie: 'demo_cookie=sample',
      key: 'sample-request',
      body,
    });
  });

  it('reports an unavailable upstream as a failed request, never a successful booking', async () => {
    const unavailable = createServer();
    const port = await listen(unavailable);
    await close(unavailable);
    const isolated = await createCabinDemoServer(port);
    const local = `http://127.0.0.1:${await listen(isolated)}`;
    try {
      const response = await fetch(`${local}/v1/properties/sample-bungalow`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: { message: 'The API is unavailable. Start the local Compose app.' },
      });
    } finally {
      await close(isolated);
    }
  });
});
