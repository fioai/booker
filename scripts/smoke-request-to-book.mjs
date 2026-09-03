/* global process, fetch, URL */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', 'app']);

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/smoke-request-to-book.mjs',
      '',
      'Required environment:',
      '  SMOKE_BASE_URL, SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD, SMOKE_PROPERTY_ID,',
      '  SMOKE_ARRIVAL, SMOKE_DEPARTURE, SMOKE_IDEMPOTENCY_KEY.',
      '',
      'Optional environment:',
      '  SMOKE_ADMIN_ORIGIN when the browser-facing origin differs from the request URL.',
      '',
      'The exercise is intentionally limited to local hosts and performs public property,',
      'availability, quote, request-to-book, admin login, recheck, approve, and read-back calls.',
    ].join('\n') + '\n',
  );
}

function required(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(name + ' is required.');
  }
  return value;
}

function localHttpUrl(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(name + ' must be a valid HTTP URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(name + ' must use HTTP(S).');
  }
  // URL.hostname keeps brackets around IPv6 hosts.
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(name + ' is restricted to a local clean-room host.');
  }
  return url;
}

function localBaseUrl() {
  return localHttpUrl('SMOKE_BASE_URL', required('SMOKE_BASE_URL')).toString().replace(/\/$/u, '');
}

function localAdminOrigin(baseUrl) {
  const raw = process.env.SMOKE_ADMIN_ORIGIN?.trim();
  if (raw === undefined || raw.length === 0) {
    return new URL(baseUrl).origin;
  }
  const url = localHttpUrl('SMOKE_ADMIN_ORIGIN', raw);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SMOKE_ADMIN_ORIGIN must be an exact HTTP(S) origin.');
  }
  return url.origin;
}

function record(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(name + ' returned a non-object response.');
  }
  return value;
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get('set-cookie');
  if (combined === null) {
    return [];
  }
  return combined.split(/,(?=[^;,=\s]+=[^;,]*)/u);
}

function mergeCookies(jar, response) {
  for (const header of responseCookies(response)) {
    const pair = header.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return [...jar.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

async function jsonRequest(baseUrl, pathname, options, expectedStatus) {
  const response = await fetch(baseUrl + pathname, options);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    throw new Error(pathname + ' returned invalid JSON.');
  }
  if (response.status !== expectedStatus) {
    const code =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'code' in body.error
        ? String(body.error.code)
        : 'unclassified';
    throw new Error(
      pathname +
        ' returned HTTP ' +
        response.status +
        ' (' +
        code +
        '), expected ' +
        expectedStatus +
        '.',
    );
  }
  return body;
}

function jsonOptions(body, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const baseUrl = localBaseUrl();
  const adminOrigin = localAdminOrigin(baseUrl);
  const propertyId = required('SMOKE_PROPERTY_ID');
  const arrival = required('SMOKE_ARRIVAL');
  const departure = required('SMOKE_DEPARTURE');
  const idempotencyKey = required('SMOKE_IDEMPOTENCY_KEY');
  const guestEmail = process.env.SMOKE_GUEST_EMAIL?.trim() || 'smoke-guest@example.test';
  const guestName = process.env.SMOKE_GUEST_NAME?.trim() || 'Clean-room smoke guest';
  const guestMessage =
    process.env.SMOKE_GUEST_MESSAGE?.trim() || 'Deterministic local smoke request.';
  const adminEmail = required('SMOKE_ADMIN_EMAIL');
  const adminPassword = required('SMOKE_ADMIN_PASSWORD');

  const property = record(
    await jsonRequest(baseUrl, '/v1/properties/' + encodeURIComponent(propertyId), {}, 200),
    'property',
  );
  if (property.id !== propertyId || 'operationalNotes' in property) {
    throw new Error('public property response crossed its privacy boundary.');
  }
  const availability = record(
    await jsonRequest(
      baseUrl,
      '/v1/properties/' +
        encodeURIComponent(propertyId) +
        '/availability?arrival=' +
        encodeURIComponent(arrival) +
        '&departure=' +
        encodeURIComponent(departure),
      {},
      200,
    ),
    'availability',
  );
  if (availability.available !== true) {
    throw new Error('sample smoke dates were not available.');
  }
  const quote = record(
    await jsonRequest(
      baseUrl,
      '/v1/properties/' + encodeURIComponent(propertyId) + '/quote',
      jsonOptions({ arrival, departure }),
      200,
    ),
    'quote',
  );
  if (
    quote.propertyId !== propertyId ||
    !Number.isSafeInteger(quote.totalMinor) ||
    quote.totalMinor <= 0
  ) {
    throw new Error('quote response did not contain a positive bounded total.');
  }
  const publicRequest = record(
    await jsonRequest(
      baseUrl,
      '/v1/properties/' + encodeURIComponent(propertyId) + '/request-to-book',
      jsonOptions(
        {
          arrival,
          departure,
          guestCount: Number(process.env.SMOKE_GUEST_COUNT ?? '2'),
          guestName,
          guestEmail,
          message: guestMessage,
        },
        { 'idempotency-key': idempotencyKey },
      ),
      201,
    ),
    'request-to-book',
  );
  if (
    publicRequest.status !== 'pending' ||
    publicRequest.propertyId !== propertyId ||
    'guestEmail' in publicRequest
  ) {
    throw new Error('public request response did not preserve pending/PII boundaries.');
  }
  const requestId = publicRequest.id;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('request-to-book response did not contain a request identifier.');
  }

  const cookies = new Map();
  const loginPage = await fetch(baseUrl + '/admin/login');
  if (loginPage.status !== 200) {
    throw new Error('admin login page returned HTTP ' + loginPage.status + '.');
  }
  const loginCookieHeader = mergeCookies(cookies, loginPage);
  const anonymousCsrf = cookies.get('booking_engine_admin_csrf');
  if (anonymousCsrf === undefined) {
    throw new Error('admin login page did not issue a CSRF cookie.');
  }
  const loginResponse = await fetch(
    baseUrl + '/admin/login',
    jsonOptions(
      { email: adminEmail, password: adminPassword },
      { cookie: loginCookieHeader, 'x-csrf-token': anonymousCsrf, origin: adminOrigin },
    ),
  );
  const loginText = await loginResponse.text();
  if (loginResponse.status !== 200) {
    throw new Error('admin login returned HTTP ' + loginResponse.status + '.');
  }
  try {
    JSON.parse(loginText);
  } catch {
    throw new Error('admin login returned invalid JSON.');
  }
  const sessionCookieHeader = mergeCookies(cookies, loginResponse);
  const session = cookies.get('booking_engine_admin_session');
  const csrf = cookies.get('booking_engine_admin_csrf');
  if (session === undefined || csrf === undefined) {
    throw new Error('admin login did not issue session and CSRF cookies.');
  }
  const adminHeaders = {
    cookie: sessionCookieHeader,
    'x-csrf-token': csrf,
    origin: adminOrigin,
  };
  const routePrefix =
    '/admin/properties/' +
    encodeURIComponent(propertyId) +
    '/booking-requests/' +
    encodeURIComponent(requestId);
  const recheck = record(
    await jsonRequest(
      baseUrl,
      routePrefix + '/recheck',
      { method: 'POST', headers: adminHeaders },
      200,
    ),
    'admin recheck',
  );
  if (recheck.available !== true) {
    throw new Error('admin recheck reported the held smoke stay as unavailable.');
  }
  const approved = record(
    await jsonRequest(
      baseUrl,
      routePrefix + '/approve',
      { method: 'POST', headers: adminHeaders },
      200,
    ),
    'admin approve',
  );
  if (approved.status !== 'approved') {
    throw new Error('admin approval did not transition the request to approved.');
  }
  const readBack = record(
    await jsonRequest(
      baseUrl,
      routePrefix,
      { method: 'GET', headers: { cookie: sessionCookieHeader } },
      200,
    ),
    'admin read-back',
  );
  if (readBack.status !== 'approved' || readBack.guestEmail !== guestEmail) {
    throw new Error('admin read-back did not contain the approved private request.');
  }
  process.stdout.write(
    'Smoke passed: property, availability, quote, request, login, recheck, approve, read-back; requestId=' +
      requestId +
      '.\n',
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'smoke failed';
  process.stderr.write('Smoke failed: ' + message + '\n');
  process.exitCode = 1;
});
