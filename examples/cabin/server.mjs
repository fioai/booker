/* global process, URL */

import { readFile, readdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const publicDirectory = new URL('./public/', import.meta.url);
const sdkDirectory = new URL('../../packages/sdk-typescript/dist/', import.meta.url);
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/owner': ['owner.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/guest.js': ['guest.js', 'text/javascript; charset=utf-8'],
  '/owner.js': ['owner.js', 'text/javascript; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/cabin.jpg': ['cabin.jpg', 'image/jpeg'],
};

/** Local-only example: fixed asset paths and a same-origin proxy to the existing API. */
export async function createCabinDemoServer(apiPort = 13000) {
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const files = new Map(
    Object.entries(publicFiles).map(([path, [name, type]]) => [
      path,
      { url: new URL(name, publicDirectory), type },
    ]),
  );
  for (const name of await readdir(sdkDirectory)) {
    if (name.endsWith('.js')) {
      files.set(`/sdk/${name}`, {
        url: new URL(name, sdkDirectory),
        type: 'text/javascript; charset=utf-8',
      });
    }
  }

  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    const fail = (status, message) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message } }));
    };

    // Check Host as well as Origin: loopback binding alone does not prevent DNS rebinding.
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    ) {
      request.resume();
      fail(403, 'Open this local demo using its printed 127.0.0.1 URL.');
      return;
    }

    const path = request.url ?? '/';
    if (path.startsWith('/v1/') || path.startsWith('/admin/') || path === '/healthz') {
      const headers = {};
      for (const name of [
        'accept',
        'content-type',
        'content-length',
        'cookie',
        'x-csrf-token',
        'idempotency-key',
      ]) {
        if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      }
      if (request.headers.origin !== undefined) headers.origin = apiOrigin;
      const upstream = httpRequest(
        apiOrigin,
        { path, method: request.method, headers, timeout: 15_000 },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.on('error', () => response.destroy());
          result.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => fail(502, 'The API is unavailable. Start the local Compose app.'));
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }

    request.resume();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      fail(405, 'Method not allowed.');
      return;
    }
    const file = files.get(path.split('?')[0]);
    if (file === undefined) {
      fail(404, 'Page not found.');
      return;
    }
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    );
    void readFile(file.url)
      .then((body) => {
        response.writeHead(200, { 'content-type': file.type });
        response.end(request.method === 'HEAD' ? undefined : body);
      })
      .catch(() => fail(500, 'A demo asset is missing. Check the example installation.'));
  });
  return server;
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '13001' },
      'api-port': { type: 'string', default: '13000' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node examples/cabin/server.mjs [--port 13001] [--api-port 13000]\n' +
        'Requires the compiled SDK and the seeded local Compose API. Binds only to 127.0.0.1.\n',
    );
    return;
  }
  const ports = [values.port, values['api-port']].map(Number);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Demo and API ports must be integers between 1 and 65535.');
  }
  const server = await createCabinDemoServer(ports[1]);
  server.on('error', () => {
    process.stderr.write('Demo could not listen. Choose another port with --port.\n');
    process.exitCode = 1;
  });
  server.listen(ports[0], '127.0.0.1', () => {
    process.stdout.write(`Juniper Cabin demo: http://127.0.0.1:${ports[0]}\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Demo startup failed. Run corepack pnpm build and check the arguments.\n');
    process.exitCode = 1;
  });
}
