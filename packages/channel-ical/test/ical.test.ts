import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';

import { describe, expect, it, vi } from 'vitest';
import {
  createICalSyncJob,
  recheckAvailabilityBeforeCommit,
} from '../../../apps/api/src/jobs/ical/sync.js';

import {
  ICalFetchError,
  createICalFetcher,
  type ICalTransportBody,
  type ICalTransportResponse,
} from '../src/fetch.js';
import { createICalChannel } from '../src/index.js';
import { ICalParseError, parseICalCalendar, type ICalEvent } from '../src/parse.js';
import {
  createMemoryICalBlockStore,
  reconcileICalFeed,
  type ICalBlockRecord,
  type ICalScope,
} from '../src/reconcile.js';
import { exportICalCalendar } from '../src/export.js';
import { createFixedClock } from '../../test-support/src/index.js';

const scopeA: ICalScope = { organizationId: 'org-a', propertyId: 'property-a' };
const scopeB: ICalScope = { organizationId: 'org-b', propertyId: 'property-a' };
const sourceId = 'airbnb-main';

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function event(overrides: Partial<ICalEvent> = {}): ICalEvent {
  return {
    uid: 'airbnb-booking-001@example.invalid',
    arrival: '2026-08-10',
    departure: '2026-08-14',
    status: 'confirmed',
    sequence: null,
    lastModified: null,
    summary: null,
    ...overrides,
  };
}

function response(body: ICalTransportBody, status = 200): ICalTransportResponse {
  return { status, headers: {}, body };
}

interface TestCalendarEvent {
  readonly uid: string;
  readonly properties?: readonly string[];
}

function calendarFeed(events: readonly TestCalendarEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0'];
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      'DTSTART;VALUE=DATE:20260810',
      'DTEND;VALUE=DATE:20260811',
      ...(event.properties ?? []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

describe('defensive iCalendar parsing', () => {
  it('parses Airbnb all-day events, unfolds escaped text, and preserves event metadata', async () => {
    const calendar = parseICalCalendar(await fixture('valid-airbnb.ics'));

    expect(calendar.events).toHaveLength(2);
    expect(calendar.events[0]).toMatchObject({
      uid: 'airbnb-booking-001@example.invalid',
      arrival: '2026-08-10',
      departure: '2026-08-14',
      summary: 'Reserved, guest stay',
      sequence: 2,
      lastModified: '2026-07-01T12:00:00.000Z',
    });
  });

  it('rejects malformed component structure instead of accepting a partial feed', async () => {
    const malformed = await fixture('malformed.ics');
    expect(() => parseICalCalendar(malformed)).toThrowError(ICalParseError);
    expect(() => parseICalCalendar(malformed)).toThrow(/VEVENT/u);
  });

  it('rejects timezone-ambiguous timed events and accepts only property-safe all-day values', async () => {
    const timezoneAmbiguous = await fixture('timezone-ambiguous.ics');
    expect(() => parseICalCalendar(timezoneAmbiguous)).toThrowError(
      expect.objectContaining({ code: 'ambiguous_timezone' }),
    );
  });

  it('bounds event count and line size before producing domain events', () => {
    const repeatedEvent = (uid: string) =>
      [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'DTSTART;VALUE=DATE:20260810',
        'DTEND;VALUE=DATE:20260811',
        'END:VEVENT',
      ].join('\r\n');
    const feed = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${Array.from({ length: 3 }, (_, index) =>
      repeatedEvent(`bounded-${index}@example.invalid`),
    ).join('\r\n')}\r\nEND:VCALENDAR\r\n`;

    expect(() => parseICalCalendar(feed, { maxEvents: 2 })).toThrowError(
      expect.objectContaining({ code: 'event_limit' }),
    );
    expect(() =>
      parseICalCalendar(`BEGIN:VCALENDAR\r\nX-HOSTILE:${'x'.repeat(100)}\r\nEND:VCALENDAR\r\n`, {
        maxLineLength: 64,
      }),
    ).toThrowError(expect.objectContaining({ code: 'line_too_long' }));
  });

  it('accepts case-insensitive all-day parameters but rejects trailing content and unknown status', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:case@example.invalid',
      'DTSTART;value=date:20260810',
      'DTEND;VALUE=DATE:20260811',
      'STATUS:NEEDS-ACTION',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(() => parseICalCalendar(feed)).toThrowError(
      expect.objectContaining({ code: 'invalid_status' }),
    );
    expect(() =>
      parseICalCalendar(
        feed.replace('STATUS:NEEDS-ACTION', 'STATUS:CONFIRMED') + '\r\nX-TRAILING:value',
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_component' }));
  });

  it('accepts a complete empty calendar so a successful empty feed stays conservative', () => {
    const calendar = parseICalCalendar(
      ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN', 'END:VCALENDAR'].join('\r\n'),
    );

    expect(calendar.events).toEqual([]);
  });

  it('accepts a UTF-8 BOM before an otherwise valid calendar', () => {
    const calendar = parseICalCalendar(
      `\uFEFF${['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'].join('\r\n')}`,
    );

    expect(calendar.events).toEqual([]);
  });

  it('rejects year zero in all-day event dates', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:year-zero@example.invalid',
      'DTSTART;VALUE=DATE:00000101',
      'DTEND;VALUE=DATE:00000102',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(() => parseICalCalendar(feed)).toThrowError(
      expect.objectContaining({ code: 'invalid_date' }),
    );
  });

  it('rejects C1 control characters in event text', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:c1-control@example.invalid',
      'DTSTART;VALUE=DATE:20260810',
      'DTEND;VALUE=DATE:20260811',
      'SUMMARY:Guest\u0085text',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(() => parseICalCalendar(feed)).toThrowError(
      expect.objectContaining({ code: 'text_too_long' }),
    );
  });

  it('rejects year zero in UTC event metadata timestamps', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:timestamp-year-zero@example.invalid',
      'DTSTAMP:00000101T000000Z',
      'DTSTART;VALUE=DATE:20260810',
      'DTEND;VALUE=DATE:20260811',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(() => parseICalCalendar(feed)).toThrowError(
      expect.objectContaining({ code: 'invalid_timestamp' }),
    );
  });

  it('decodes the standards-escaped newline form in safe event text', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:escaped-newline@example.invalid',
      'DTSTART;VALUE=DATE:20260810',
      'DTEND;VALUE=DATE:20260811',
      'SUMMARY:line one\\nline two',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect(parseICalCalendar(feed).events[0]?.summary).toBe('line one\nline two');
  });

  it.each([
    { name: 'RRULE', line: 'RRULE:FREQ=DAILY' },
    { name: 'EXRULE', line: 'EXRULE:FREQ=DAILY' },
    { name: 'RDATE', line: 'RDATE;VALUE=DATE:20260812' },
    { name: 'EXDATE', line: 'EXDATE;VALUE=DATE:20260812' },
    {
      name: 'RECURRENCE-ID',
      line: 'RECURRENCE-ID;VALUE=DATE:20260810',
    },
  ])('rejects unsupported $name recurrence instead of keeping one occurrence', ({ line }) => {
    const feed = calendarFeed([
      {
        uid: 'recurring@example.invalid',
        properties: [line],
      },
    ]);

    expect(() => parseICalCalendar(feed)).toThrowError(
      expect.objectContaining({ code: 'unsupported_recurrence' }),
    );
  });

  it('preserves distinct UID values exactly', () => {
    const calendar = parseICalCalendar(
      calendarFeed([{ uid: 'booking-1@example.invalid' }, { uid: 'booking 1@example.invalid' }]),
    );

    expect(calendar.events.map(({ uid }) => uid)).toEqual([
      'booking-1@example.invalid',
      'booking 1@example.invalid',
    ]);
  });

  it('rejects UID boundary whitespace instead of trimming identity', () => {
    for (const uid of [
      ' padded@example.invalid',
      'padded@example.invalid ',
      '\u00a0padded@example.invalid',
    ]) {
      expect(() => parseICalCalendar(calendarFeed([{ uid }]))).toThrowError(
        expect.objectContaining({ code: 'invalid_uid' }),
      );
    }
  });

  it('rejects raw and escaped control characters in UIDs', () => {
    for (const uid of [
      'control\u0001@example.invalid',
      'control\u0085@example.invalid',
      'control\\n@example.invalid',
    ]) {
      expect(() => parseICalCalendar(calendarFeed([{ uid }]))).toThrowError(
        expect.objectContaining({ code: 'invalid_uid' }),
      );
    }
  });

  it('emits transparent events as non-blocking cancellations and keeps opaque events', () => {
    const calendar = parseICalCalendar(
      calendarFeed([
        {
          uid: 'opaque@example.invalid',
          properties: ['TRANSP:OPAQUE'],
        },
        {
          uid: 'transparent@example.invalid',
          properties: ['TRANSP:TRANSPARENT', 'SEQUENCE:2', 'LAST-MODIFIED:20260702T120000Z'],
        },
      ]),
    );

    expect(calendar.events).toMatchObject([
      {
        uid: 'opaque@example.invalid',
        status: 'confirmed',
      },
      {
        uid: 'transparent@example.invalid',
        status: 'cancelled',
        sequence: 2,
        lastModified: '2026-07-02T12:00:00.000Z',
      },
    ]);
    expect(() =>
      parseICalCalendar(
        calendarFeed([
          {
            uid: 'transparent-1@example.invalid',
            properties: ['TRANSP:TRANSPARENT'],
          },
          {
            uid: 'transparent-2@example.invalid',
            properties: ['TRANSP:TRANSPARENT'],
          },
        ]),
        { maxEvents: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: 'event_limit' }));
  });

  it('rejects invalid and duplicate TRANSP properties', () => {
    expect(() =>
      parseICalCalendar(
        calendarFeed([
          {
            uid: 'invalid-transparency@example.invalid',
            properties: ['TRANSP:FREE'],
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_transparency' }));

    expect(() =>
      parseICalCalendar(
        calendarFeed([
          {
            uid: 'duplicate-transparency@example.invalid',
            properties: ['TRANSP:OPAQUE', 'TRANSP:TRANSPARENT'],
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'duplicate_property' }));
  });

  it('accepts the SEQUENCE bounds and rejects values outside non-negative RFC semantics', () => {
    const calendar = parseICalCalendar(
      calendarFeed([
        {
          uid: 'zero-sequence@example.invalid',
          properties: ['SEQUENCE:0'],
        },
        {
          uid: 'positive-sequence@example.invalid',
          properties: ['SEQUENCE:+1'],
        },
        {
          uid: 'leading-zero-sequence@example.invalid',
          properties: ['SEQUENCE:00000000001'],
        },
        {
          uid: 'max-sequence@example.invalid',
          properties: ['SEQUENCE:2147483647'],
        },
      ]),
    );

    expect(calendar.events.map(({ sequence }) => sequence)).toEqual([0, 1, 1, 2_147_483_647]);
    for (const sequence of ['-1', '1.5', '2147483648', '00000000002147483648', '9'.repeat(100)]) {
      expect(() =>
        parseICalCalendar(
          calendarFeed([
            {
              uid: `sequence-${sequence}@example.invalid`,
              properties: [`SEQUENCE:${sequence}`],
            },
          ]),
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_sequence' }));
    }
  });

  it('unfolds many continuations at the exact encoded line boundary', () => {
    const continuationCount = 1_999;
    const feed = calendarFeed([
      {
        uid: 'many-continuations@example.invalid',
        properties: ['SUMMARY:a', ...Array.from({ length: continuationCount }, () => ' a')],
      },
    ]);

    expect(parseICalCalendar(feed, { maxLineLength: 2_008 }).events[0]?.summary).toBe(
      'a'.repeat(2_000),
    );
    expect(() => parseICalCalendar(feed, { maxLineLength: 2_007 })).toThrowError(
      expect.objectContaining({ code: 'line_too_long' }),
    );
  });
});

describe('SSRF-safe bounded iCalendar fetching', () => {
  it('requires HTTPS and rejects private, loopback, link-local, and metadata resolutions', async () => {
    const transport = vi.fn(async (): Promise<ICalTransportResponse> => response('never'));
    const fetcher = createICalFetcher({
      transport,
      resolveHost: async (hostname) => {
        if (hostname === 'private.example') {
          return ['192.168.1.10'];
        }
        return ['93.184.216.34'];
      },
    });

    await expect(fetcher.fetch('http://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'insecure_protocol',
    });
    await expect(fetcher.fetch('https://private.example/feed.ics')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    await expect(fetcher.fetch('https://169.254.169.254/latest/meta-data')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('validates every redirect and refuses a redirect to a private network', async () => {
    const transport = vi
      .fn<
        (
          url: URL,
          input: { readonly signal: AbortSignal; readonly addresses: readonly string[] },
        ) => Promise<ICalTransportResponse>
      >()
      .mockResolvedValueOnce(response('', 302))
      .mockResolvedValueOnce(response('should not be fetched'));
    const fetcher = createICalFetcher({
      transport: async (url, input) => {
        if (url.hostname === 'public.example') {
          return {
            ...response('', 302),
            headers: { location: 'https://private.example/feed.ics' },
          };
        }
        return transport(url, input);
      },
      resolveHost: async (hostname) =>
        hostname === 'private.example' ? ['10.0.0.8'] : ['93.184.216.34'],
    });

    await expect(fetcher.fetch('https://public.example/feed.ics')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('detects a DNS resolution change before the request is sent', async () => {
    const resolveHost = vi
      .fn<(hostname: string) => Promise<readonly string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1']);
    const transport = vi.fn(async (): Promise<ICalTransportResponse> => response('never'));
    const fetcher = createICalFetcher({ transport, resolveHost });

    await expect(fetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'dns_rebinding',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('bounds redirects, body bytes, and transport time with deterministic injected I/O', async () => {
    const redirectFetcher = createICalFetcher({
      maxRedirects: 1,
      resolveHost: async () => ['93.184.216.34'],
      transport: async (url) => ({
        ...response('', 302),
        headers: { location: `${url.origin}${url.pathname}` },
      }),
    });
    await expect(redirectFetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'redirect_limit',
    });

    const bodyFetcher = createICalFetcher({
      maxBodyBytes: 8,
      resolveHost: async () => ['93.184.216.34'],
      transport: async () => response('0123456789'),
    });
    await expect(bodyFetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'body_limit',
    });

    const slowFetcher = createICalFetcher({
      timeoutMs: 10,
      resolveHost: async () => ['93.184.216.34'],
      transport: (_url, { signal }) =>
        new Promise<ICalTransportResponse>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new ICalFetchError('timeout', 'calendar request timed out.')),
            { once: true },
          );
        }),
    });
    await expect(slowFetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('requires a positive timeout configuration while allowing zero redirects', () => {
    expect(() => createICalFetcher({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createICalFetcher({ maxRedirects: 0 })).not.toThrow();
  });

  it('does not include the private source URL in operational errors', async () => {
    const secretUrl = 'https://user:secret@private.example/feed.ics?token=do-not-log';
    const fetcher = createICalFetcher({ resolveHost: async () => ['127.0.0.1'] });

    const error = await fetcher.fetch(secretUrl).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ICalFetchError);
    expect(String(error)).not.toContain('secret');
    expect(String(error)).not.toContain('do-not-log');
    expect(String(error)).not.toContain(secretUrl);
    const constructed = new ICalFetchError('network_error', secretUrl);
    expect(String(constructed)).not.toContain(secretUrl);
    expect(String(constructed)).not.toContain('secret');
  });

  it('applies the timeout to a streaming body and normalizes transport errors', async () => {
    const slowBody = async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('BEGIN:VCALENDAR');
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      yield new TextEncoder().encode('');
    };
    const bodyFetcher = createICalFetcher({
      timeoutMs: 10,
      resolveHost: async () => ['93.184.216.34'],
      transport: async () => response(slowBody()),
    });
    await expect(bodyFetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'timeout',
    });

    const secret = 'https://user:secret@example.invalid/private?token=leak';
    const errorFetcher = createICalFetcher({
      resolveHost: async () => ['93.184.216.34'],
      transport: async () => {
        throw new Error(secret);
      },
    });
    const error = await errorFetcher
      .fetch('https://calendar.example/feed.ics')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ICalFetchError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain('secret');
  });

  it.each([
    { family: 'IPv4', address: '8.8.8.8' },
    { family: 'IPv4', address: '93.184.216.34' },
    { family: 'IPv6', address: '2001:4860:4860::8888' },
    { family: 'IPv6', address: '2606:4700:4700::1111' },
    { family: 'IPv6', address: '2a00:1450:4001:81b::200e' },
  ])('allows globally routable $family address $address', async ({ address }) => {
    const transport = vi.fn(async (): Promise<ICalTransportResponse> => response('calendar'));
    const fetcher = createICalFetcher({
      resolveHost: async () => [address],
      transport,
    });

    await expect(fetcher.fetch('https://calendar.example/feed.ics')).resolves.toMatchObject({
      body: 'calendar',
    });
    expect(transport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ addresses: [address] }),
    );
  });

  it.each([
    { family: 'IPv4', address: '0.0.0.1' },
    { family: 'IPv4', address: '10.0.0.1' },
    { family: 'IPv4', address: '100.64.0.1' },
    { family: 'IPv4', address: '127.0.0.1' },
    { family: 'IPv4', address: '169.254.1.1' },
    { family: 'IPv4', address: '192.0.2.1' },
    { family: 'IPv4', address: '198.18.0.1' },
    { family: 'IPv4', address: '198.51.100.1' },
    { family: 'IPv4', address: '203.0.113.1' },
    { family: 'IPv4', address: '224.0.0.1' },
    { family: 'IPv4', address: '240.0.0.1' },
    { family: 'IPv6', address: '::1' },
    { family: 'IPv6', address: '::ffff:192.168.1.1' },
    { family: 'IPv6', address: '::ffff:8.8.8.8' },
    { family: 'IPv6', address: '100::1' },
    { family: 'IPv6', address: '2001:2::1' },
    { family: 'IPv6', address: '2001:db8::1' },
    { family: 'IPv6', address: '3fff::1' },
    { family: 'IPv6', address: '5f00::1' },
    { family: 'IPv6', address: 'fc00::1' },
    { family: 'IPv6', address: 'fe80::1' },
    { family: 'IPv6', address: 'fec0::1' },
    { family: 'IPv6', address: 'ff02::1' },
  ])('rejects non-global or special-purpose $family address $address', async ({ address }) => {
    const transport = vi.fn(async (): Promise<ICalTransportResponse> => response('never'));
    const fetcher = createICalFetcher({
      resolveHost: async () => [address],
      transport,
    });

    await expect(fetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
      code: 'blocked_address',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { contentLength: 'not-a-number', code: 'network_error' },
    { contentLength: '1000001', code: 'body_limit' },
  ])(
    'destroys a response with invalid Content-Length $contentLength',
    async ({ contentLength, code }) => {
      const destroy = vi.fn();
      const body = {
        destroy,
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode('unread');
        },
      };
      const fetcher = createICalFetcher({
        resolveHost: async () => ['93.184.216.34'],
        transport: async () => ({
          status: 200,
          headers: { 'content-length': contentLength },
          body,
        }),
      });

      await expect(fetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
        code,
      });
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it('closes a server response body before returning an HTTP error', async () => {
    let responseClosed = false;
    let markResponseClosed: (() => void) | undefined;
    const responseClosedPromise = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const server = createServer((_request, serverResponse) => {
      serverResponse.socket?.unref();
      serverResponse.writeHead(503, { 'content-type': 'text/plain' });
      serverResponse.write('partial error body');
      serverResponse.once('close', () => {
        responseClosed = true;
        markResponseClosed?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

    try {
      const serverAddress = server.address();
      if (serverAddress === null || typeof serverAddress === 'string') {
        throw new Error('test server did not bind to a TCP port.');
      }
      const fetcher = createICalFetcher({
        resolveHost: async () => ['93.184.216.34'],
        transport: (_url, { signal }) =>
          new Promise<ICalTransportResponse>((resolve, reject) => {
            const request = httpRequest(
              {
                hostname: '127.0.0.1',
                port: serverAddress.port,
                path: '/',
                method: 'GET',
              },
              (incoming) => {
                resolve({
                  status: incoming.statusCode ?? 0,
                  headers: {},
                  body: incoming,
                });
              },
            );
            const abort = (): void => {
              request.destroy();
            };
            signal.addEventListener('abort', abort, { once: true });
            request.once('close', () => signal.removeEventListener('abort', abort));
            request.once('error', reject);
            request.end();
          }),
      });

      await expect(fetcher.fetch('https://calendar.example/feed.ics')).rejects.toMatchObject({
        code: 'http_error',
      });
      await responseClosedPromise;
      expect(responseClosed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });
});

describe('tenant-scoped idempotent iCalendar reconciliation', () => {
  it('creates a source/UID block once and makes a repeated feed a no-op', async () => {
    const store = createMemoryICalBlockStore();
    const first = await reconcileICalFeed(scopeA, sourceId, [event()], store);
    const second = await reconcileICalFeed(scopeA, sourceId, [event()], store);

    expect(first.decisions).toMatchObject([{ action: 'created', uid: event().uid }]);
    expect(second.decisions).toMatchObject([{ action: 'unchanged', uid: event().uid }]);
    expect(await store.list(scopeA, sourceId)).toHaveLength(1);
  });

  it('accepts the maximum direct sequence and rejects invalid sequences before store writes', async () => {
    const acceptedStore = createMemoryICalBlockStore();
    await expect(
      reconcileICalFeed(scopeA, sourceId, [event({ sequence: 2_147_483_647 })], acceptedStore),
    ).resolves.toMatchObject({
      decisions: [{ action: 'created' }],
    });
    await expect(acceptedStore.list(scopeA, sourceId)).resolves.toMatchObject([
      { sequence: 2_147_483_647 },
    ]);

    for (const [index, sequence] of [-1, 1.5, 2_147_483_648].entries()) {
      const store = createMemoryICalBlockStore();
      const upsert = vi.spyOn(store, 'upsert');
      const release = vi.spyOn(store, 'release');

      await expect(
        reconcileICalFeed(
          scopeA,
          sourceId,
          [
            event({ uid: 'valid-before-invalid-sequence@example.invalid' }),
            event({ uid: `invalid-sequence-${index}@example.invalid`, sequence }),
          ],
          store,
        ),
      ).rejects.toThrow('iCalendar event sequence is invalid.');
      expect(upsert).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    }
  });

  it('does not cross tenant boundaries even when source and UID are reused', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event()], store);
    await reconcileICalFeed(scopeB, sourceId, [event()], store);

    expect(await store.list(scopeA, sourceId)).toHaveLength(1);
    expect(await store.list(scopeB, sourceId)).toHaveLength(1);
    expect((await store.list(scopeA, sourceId))[0]?.organizationId).toBe('org-a');
    expect((await store.list(scopeB, sourceId))[0]?.organizationId).toBe('org-b');
  });

  it('accepts a versioned modification, but retains an ambiguous unversioned change', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event()], store);

    const ambiguous = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ departure: '2026-08-15', sequence: null, lastModified: null })],
      store,
    );
    expect(ambiguous.decisions).toMatchObject([{ action: 'needs_review' }]);
    expect((await store.list(scopeA, sourceId))[0]?.departure).toBe('2026-08-14');

    const modified = await reconcileICalFeed(
      scopeA,
      sourceId,
      [
        event({
          departure: '2026-08-15',
          sequence: 2,
          lastModified: '2026-07-02T12:00:00.000Z',
        }),
      ],
      store,
    );
    expect(modified.decisions).toMatchObject([{ action: 'updated' }]);
    expect((await store.list(scopeA, sourceId))[0]?.departure).toBe('2026-08-15');
  });

  it('releases explicit cancellations but retains records missing from a feed', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event()], store);

    const missing = await reconcileICalFeed(scopeA, sourceId, [], store);
    expect(missing.decisions).toMatchObject([{ action: 'retained_missing' }]);
    expect((await store.list(scopeA, sourceId))[0]?.status).toBe('active');

    const cancelled = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ status: 'cancelled', sequence: 2 })],
      store,
    );
    expect(cancelled.decisions).toMatchObject([{ action: 'released' }]);
    expect((await store.list(scopeA, sourceId))[0]?.status).toBe('released');
  });

  it('ignores a first transparent event and releases a prior opaque block', async () => {
    const uid = 'transparency-transition@example.invalid';
    const opaqueEvents = parseICalCalendar(
      calendarFeed([{ uid, properties: ['TRANSP:OPAQUE', 'SEQUENCE:1'] }]),
    ).events;
    const transparentEvents = parseICalCalendar(
      calendarFeed([
        {
          uid,
          properties: ['TRANSP:TRANSPARENT', 'SEQUENCE:2', 'LAST-MODIFIED:20260702T120000Z'],
        },
      ]),
    ).events;
    expect(transparentEvents).toMatchObject([
      {
        uid,
        status: 'cancelled',
        sequence: 2,
        lastModified: '2026-07-02T12:00:00.000Z',
      },
    ]);

    const store = createMemoryICalBlockStore();
    await expect(
      reconcileICalFeed(scopeA, sourceId, transparentEvents, store),
    ).resolves.toMatchObject({
      decisions: [{ action: 'ignored_cancelled', uid }],
    });
    expect(await store.list(scopeA, sourceId)).toEqual([]);

    await expect(reconcileICalFeed(scopeA, sourceId, opaqueEvents, store)).resolves.toMatchObject({
      decisions: [{ action: 'created', uid }],
    });
    await expect(
      reconcileICalFeed(scopeA, sourceId, transparentEvents, store),
    ).resolves.toMatchObject({
      decisions: [{ action: 'released', uid }],
    });
    expect(await store.list(scopeA, sourceId)).toMatchObject([
      {
        uid,
        status: 'released',
        sequence: 2,
        lastModified: '2026-07-02T12:00:00.000Z',
      },
    ]);
  });

  it('handles duplicate UIDs deterministically without creating two occupancy blocks', async () => {
    const store = createMemoryICalBlockStore();
    const result = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ sequence: 4 }), event({ sequence: 4, departure: '2026-08-15' })],
      store,
    );

    expect(result.decisions).toMatchObject([{ action: 'needs_review' }]);
    expect(await store.list(scopeA, sourceId)).toHaveLength(0);
  });

  it('treats even identical duplicate UIDs as ambiguous and refuses to create occupancy', async () => {
    const store = createMemoryICalBlockStore();
    const result = await reconcileICalFeed(scopeA, sourceId, [event(), event()], store);

    expect(result.decisions).toMatchObject([{ action: 'needs_review', reason: 'duplicate_uid' }]);
    expect(await store.list(scopeA, sourceId)).toHaveLength(0);
  });

  it('does not let an older cancellation release a newer active record', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event({ sequence: 3 })], store);

    const result = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ status: 'cancelled', sequence: 2 })],
      store,
    );

    expect(result.decisions).toMatchObject([{ action: 'needs_review' }]);
    expect((await store.list(scopeA, sourceId))[0]?.status).toBe('active');
  });

  it('retains a versioned active record when cancellation provenance is missing', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event({ sequence: 3 })], store);

    const result = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ status: 'cancelled', sequence: null, lastModified: null })],
      store,
    );

    expect(result.decisions).toMatchObject([
      { action: 'needs_review', reason: 'ambiguous_cancellation_version' },
    ]);
    expect((await store.list(scopeA, sourceId))[0]?.status).toBe('active');
  });

  it('persists cancellation provenance so a later stale active event cannot resurrect a block', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event({ sequence: 1 })], store);

    await expect(
      reconcileICalFeed(
        scopeA,
        sourceId,
        [
          event({
            status: 'cancelled',
            sequence: 3,
            lastModified: '2026-07-03T12:00:00.000Z',
          }),
        ],
        store,
      ),
    ).resolves.toMatchObject({ decisions: [{ action: 'released' }] });
    expect((await store.list(scopeA, sourceId))[0]).toMatchObject({
      status: 'released',
      sequence: 3,
      lastModified: '2026-07-03T12:00:00.000Z',
    });

    const staleReappearance = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ sequence: 2, lastModified: '2026-07-02T12:00:00.000Z' })],
      store,
    );
    expect(staleReappearance.decisions).toMatchObject([
      { action: 'needs_review', reason: 'reappeared_without_new_version' },
    ]);
    expect((await store.list(scopeA, sourceId))[0]?.status).toBe('released');
  });

  it('updates released provenance for a newer repeated cancellation', async () => {
    const store = createMemoryICalBlockStore();
    await reconcileICalFeed(scopeA, sourceId, [event({ sequence: 1 })], store);
    await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ status: 'cancelled', sequence: 2, lastModified: '2026-07-02T12:00:00.000Z' })],
      store,
    );

    const repeated = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ status: 'cancelled', sequence: 3, lastModified: '2026-07-03T12:00:00.000Z' })],
      store,
    );
    expect(repeated.decisions).toMatchObject([{ action: 'unchanged' }]);
    expect((await store.list(scopeA, sourceId))[0]).toMatchObject({
      status: 'released',
      sequence: 3,
      lastModified: '2026-07-03T12:00:00.000Z',
    });

    const stale = await reconcileICalFeed(
      scopeA,
      sourceId,
      [event({ sequence: 2, lastModified: '2026-07-02T12:00:00.000Z' })],
      store,
    );
    expect(stale.decisions).toMatchObject([
      { action: 'needs_review', reason: 'reappeared_without_new_version' },
    ]);
  });

  it('rejects control-bearing provenance before it can enter a tenant/source/UID key', async () => {
    const store = createMemoryICalBlockStore();

    await expect(
      reconcileICalFeed(scopeA, sourceId, [event({ uid: 'unsafe\u0000uid' })], store),
    ).rejects.toThrow(TypeError);
    await expect(
      reconcileICalFeed(scopeA, sourceId, [event({ summary: 'unsafe\r\nsummary' })], store),
    ).rejects.toThrow(TypeError);
    expect(await store.list(scopeA, sourceId)).toEqual([]);
  });

  it('keeps direct memory-store writes under the same tenant and UID validation', async () => {
    const store = createMemoryICalBlockStore();
    const baseRecord: ICalBlockRecord = {
      organizationId: scopeA.organizationId,
      propertyId: scopeA.propertyId,
      sourceId,
      uid: event().uid,
      arrival: event().arrival,
      departure: event().departure,
      status: 'active',
      eventStatus: 'confirmed',
      sequence: null,
      lastModified: null,
      summary: null,
    };

    await expect(store.upsert(scopeA, { ...baseRecord, uid: 'unsafe\u0000uid' })).rejects.toThrow(
      TypeError,
    );
    await expect(
      store.upsert(scopeA, { ...baseRecord, organizationId: scopeB.organizationId }),
    ).rejects.toThrow(TypeError);
    await expect(store.release(scopeA, sourceId, 'unsafe\u0000uid')).rejects.toThrow(TypeError);
  });

  it('retains standards-escaped line breaks in safe event text', async () => {
    const store = createMemoryICalBlockStore();

    await expect(
      reconcileICalFeed(scopeA, sourceId, [event({ summary: 'line one\nline two' })], store),
    ).resolves.toMatchObject({ decisions: [{ action: 'created' }] });
  });
});

describe('direct reservation iCalendar export', () => {
  it('exports an empty standards-shaped calendar that an independent parser can read', () => {
    const output = exportICalCalendar({ reservations: [] });

    expect(parseICalCalendar(output).events).toEqual([]);
    expect(output).toContain('METHOD:PUBLISH\r\n');
    expect(output.endsWith('\r\n')).toBe(true);
  });

  it('exports a standards-shaped calendar that an independent parser can read', () => {
    const output = exportICalCalendar({
      calendarName: 'Booking Engine direct reservations',
      reservations: [
        {
          uid: 'reservation-001@booking-engine.invalid',
          summary: 'Direct stay',
          arrival: '2026-10-10',
          departure: '2026-10-13',
          updatedAt: '2026-07-12T12:00:00.000Z',
        },
      ],
    });

    const unfolded = output.replace(/\r\n[ \t]/gu, '').split('\r\n');
    const eventLines = unfolded.slice(
      unfolded.indexOf('BEGIN:VEVENT') + 1,
      unfolded.indexOf('END:VEVENT'),
    );
    const properties = new Map(
      eventLines.map((line) => line.split(/:(.*)/u, 2) as [string, string]),
    );

    expect(output).toContain('BEGIN:VCALENDAR\r\n');
    expect(output).toContain('METHOD:PUBLISH\r\n');
    expect(properties.get('UID')).toBe('reservation-001@booking-engine.invalid');
    expect(properties.get('DTSTART;VALUE=DATE')).toBe('20261010');
    expect(properties.get('DTEND;VALUE=DATE')).toBe('20261013');
    expect(properties.get('SUMMARY')).toBe('Direct stay');
    expect(output).not.toContain('organizationId');
    expect(output.endsWith('\r\n')).toBe(true);
  });

  it('neutralizes line injection and rejects invalid reservation intervals', () => {
    const output = exportICalCalendar({
      reservations: [
        {
          uid: 'reservation-002@booking-engine.invalid',
          summary: 'Guest\r\nX-INJECTED:yes',
          arrival: '2026-10-10',
          departure: '2026-10-11',
        },
      ],
    });
    expect(output).not.toContain('\r\nX-INJECTED:yes');
    expect(output).toContain('SUMMARY:Guest X-INJECTED:yes');

    expect(() =>
      exportICalCalendar({
        reservations: [
          {
            uid: 'bad@booking-engine.invalid',
            summary: 'Bad',
            arrival: '2026-10-11',
            departure: '2026-10-11',
          },
        ],
      }),
    ).toThrow(/departure/u);

    expect(() =>
      exportICalCalendar({
        reservations: [
          {
            uid: 'year-zero@booking-engine.invalid',
            summary: 'Bad date',
            arrival: '0000-01-01',
            departure: '0000-01-02',
          },
        ],
      }),
    ).toThrow(/valid/u);

    expect(() =>
      exportICalCalendar({
        reservations: [
          {
            uid: ' padded-uid@booking-engine.invalid ',
            summary: 'Padded UID',
            arrival: '2026-10-10',
            departure: '2026-10-11',
          },
        ],
      }),
    ).toThrow(/uid/u);
  });

  it('folds long UTF-8 lines and remains readable by the independent parser', () => {
    const summary = 'é'.repeat(100);
    const output = exportICalCalendar({
      reservations: [
        {
          uid: 'reservation-unicode@booking-engine.invalid',
          summary,
          arrival: '2026-10-10',
          departure: '2026-10-11',
          updatedAt: '2026-07-12T12:00:00.000Z',
        },
      ],
    });

    expect(parseICalCalendar(output).events[0]?.summary).toBe(summary);
    for (const line of output.split('\r\n')) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    }
  });

  it('requires explicit string timezones and keeps offset conversion deterministic', () => {
    const reservation = {
      uid: 'timestamp-zone@booking-engine.invalid',
      summary: 'Timestamp zone',
      arrival: '2026-10-10',
      departure: '2026-10-11',
    };

    expect(() =>
      exportICalCalendar({
        reservations: [
          {
            ...reservation,
            updatedAt: '2026-07-12T12:00:00',
          },
        ],
      }),
    ).toThrow(/offset/u);

    const offsetOutput = exportICalCalendar({
      reservations: [
        {
          ...reservation,
          updatedAt: '2026-07-12T14:00:00+02:00',
        },
      ],
    });
    const dateOutput = exportICalCalendar({
      reservations: [
        {
          ...reservation,
          updatedAt: new Date('2026-07-12T12:00:00Z'),
        },
      ],
    });

    expect(offsetOutput).toContain('DTSTAMP:20260712T120000Z\r\n');
    expect(offsetOutput).toContain('LAST-MODIFIED:20260712T120000Z\r\n');
    expect(dateOutput).toContain('DTSTAMP:20260712T120000Z\r\n');
  });

  it('rejects impossible timestamp fields and accepts a real leap day with an offset', () => {
    const reservation = {
      uid: 'timestamp-validation@booking-engine.invalid',
      summary: 'Timestamp validation',
      arrival: '2026-10-10',
      departure: '2026-10-11',
    };
    const exportAt = (updatedAt: string | Date) =>
      exportICalCalendar({
        reservations: [{ ...reservation, updatedAt }],
      });

    expect(exportAt('2024-02-29T23:30:00+0130')).toContain('DTSTAMP:20240229T220000Z\r\n');
    for (const updatedAt of [
      '2026-02-29T12:00:00Z',
      '2024-02-30T12:00:00Z',
      '2026-13-01T12:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T12:60:00Z',
      '2026-01-01T12:00:60Z',
      '2026-01-01T12:00:00+24:00',
      '2026-01-01T12:00:00+02:60',
      '2026-01-01T12:00:00+2:00',
    ]) {
      expect(() => exportAt(updatedAt)).toThrow(/valid timestamp/u);
    }
  });
});

describe('sync health and immediate approval/payment availability recheck', () => {
  it('records the success timestamp when reconciliation completes', async () => {
    let now = '2026-07-12T12:00:00.000Z';
    const clock = { now: () => new Date(now) };
    const job = createICalSyncJob({
      clock,
      store: createMemoryICalBlockStore(),
      fetchFeed: async () => {
        now = '2026-07-12T12:00:03.000Z';
        return fixture('valid-airbnb.ics');
      },
    });

    const result = await job.run({
      scope: scopeA,
      sourceId,
      url: 'https://calendar.example/feed.ics',
    });

    expect(result.health).toMatchObject({
      lastAttemptAt: '2026-07-12T12:00:00.000Z',
      lastSuccessAt: '2026-07-12T12:00:03.000Z',
    });
  });

  it('records last attempt, last success, stale, and safe error state through the real job', async () => {
    const clock = createFixedClock('2026-07-12T12:00:00.000Z');
    const store = createMemoryICalBlockStore();
    const fetchFeed = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValueOnce(await fixture('valid-airbnb.ics'))
      .mockRejectedValueOnce(
        new ICalFetchError('http_error', 'calendar source returned an error.'),
      );
    const job = createICalSyncJob({
      clock,
      store,
      fetchFeed,
      staleAfterMs: 60_000,
    });
    const config = {
      scope: scopeA,
      sourceId,
      url: 'https://calendar.example/private-feed?token=secret',
    };

    await expect(job.run(config)).resolves.toMatchObject({ status: 'success' });
    expect(job.health(scopeA, sourceId)).toMatchObject({
      lastAttemptAt: '2026-07-12T12:00:00.000Z',
      lastSuccessAt: '2026-07-12T12:00:00.000Z',
      stale: false,
      error: null,
    });

    await expect(job.run(config)).resolves.toMatchObject({ status: 'failed' });
    const health = job.health(scopeA, sourceId);
    expect(health).toMatchObject({
      lastAttemptAt: '2026-07-12T12:00:00.000Z',
      lastSuccessAt: '2026-07-12T12:00:00.000Z',
      stale: true,
      error: { code: 'http_error' },
    });
    expect(JSON.stringify(health)).not.toContain('secret');
    expect(JSON.stringify(health)).not.toContain('calendar.example');
  });

  it.each([
    {
      code: 'unsupported_recurrence',
      message: 'The calendar source contained unsupported recurrence data.',
      properties: ['RRULE:FREQ=DAILY'],
    },
    {
      code: 'invalid_transparency',
      message: 'The calendar source returned unsupported event transparency.',
      properties: ['TRANSP:FREE'],
    },
  ])('preserves the safe $code sync error', async ({ code, message, properties }) => {
    const job = createICalSyncJob({
      store: createMemoryICalBlockStore(),
      fetchFeed: async () =>
        calendarFeed([
          {
            uid: `${code}@example.invalid`,
            properties,
          },
        ]),
    });

    const result = await job.run({
      scope: scopeA,
      sourceId,
      url: 'https://calendar.example/private-feed?token=secret',
    });

    expect(result.status).toBe('failed');
    expect(result.health.error).toEqual({ code, message });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('calendar.example');
  });

  it('rechecks the tenant-scoped stay immediately before approval or payment', async () => {
    const isAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const dependencies = { isAvailable };
    const stay = { arrival: '2026-10-10', departure: '2026-10-13' };

    await expect(
      recheckAvailabilityBeforeCommit(dependencies, scopeA, stay),
    ).resolves.toBeUndefined();
    await expect(recheckAvailabilityBeforeCommit(dependencies, scopeA, stay)).rejects.toMatchObject(
      {
        code: 'stay_unavailable',
      },
    );
    expect(isAvailable).toHaveBeenNthCalledWith(1, scopeA, 'property-a', stay);
    expect(isAvailable).toHaveBeenNthCalledWith(2, scopeA, 'property-a', stay);
  });
});

describe('iCalendar channel provenance', () => {
  it('imports explicit cancellations as cancellation records instead of silently dropping them', async () => {
    const channel = createICalChannel({
      sourceId,
      url: 'https://calendar.example/feed.ics',
      fetcher: {
        fetch: vi.fn(async () => ({
          body: await fixture('cancelled-event.ics'),
          finalUrl: 'https://calendar.example/feed.ics',
        })),
      },
    });

    await expect(channel.importBlocks()).resolves.toMatchObject([
      {
        source: sourceId,
        externalId: 'airbnb-booking-001@example.invalid',
        status: 'cancelled',
      },
    ]);
  });

  it('rejects EXRULE that excludes DTSTART instead of emitting an active block', async () => {
    const feed = calendarFeed([
      {
        uid: 'excluded-by-exrule@example.invalid',
        properties: ['EXRULE:FREQ=DAILY;COUNT=1'],
      },
    ]);
    const channel = createICalChannel({
      sourceId,
      url: 'https://calendar.example/feed.ics',
      fetcher: {
        fetch: vi.fn(async () => ({
          body: feed,
          finalUrl: 'https://calendar.example/feed.ics',
        })),
      },
    });

    await expect(channel.importBlocks()).rejects.toMatchObject({
      code: 'unsupported_recurrence',
    });
  });
});
