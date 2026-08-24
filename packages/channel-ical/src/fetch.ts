import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { TextDecoder, TextEncoder } from 'node:util';

export const ICAL_FETCH_LIMITS = Object.freeze({
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxBodyBytes: 1_000_000,
});

export type ICalFetchErrorCode =
  | 'invalid_url'
  | 'insecure_protocol'
  | 'blocked_host'
  | 'blocked_address'
  | 'dns_error'
  | 'dns_rebinding'
  | 'redirect_limit'
  | 'redirect_location'
  | 'timeout'
  | 'body_limit'
  | 'invalid_encoding'
  | 'http_error'
  | 'network_error';

const SAFE_FETCH_ERROR_MESSAGES: Readonly<Record<ICalFetchErrorCode, string>> = Object.freeze({
  invalid_url: 'calendar source URL is invalid.',
  insecure_protocol: 'calendar source requires HTTPS.',
  blocked_host: 'calendar source hostname is not allowed.',
  blocked_address: 'calendar source resolved to a blocked address.',
  dns_error: 'calendar source hostname could not be resolved.',
  dns_rebinding: 'calendar source DNS resolution changed.',
  redirect_limit: 'calendar source redirect limit exceeded.',
  redirect_location: 'calendar source redirect is invalid.',
  timeout: 'calendar source request timed out.',
  body_limit: 'calendar source body exceeds the configured limit.',
  invalid_encoding: 'calendar source body is not valid UTF-8.',
  http_error: 'calendar source returned an unsuccessful response.',
  network_error: 'calendar source request failed.',
});

export class ICalFetchError extends Error {
  readonly code: ICalFetchErrorCode;

  constructor(code: ICalFetchErrorCode, message: string) {
    void message;
    super(SAFE_FETCH_ERROR_MESSAGES[code] ?? SAFE_FETCH_ERROR_MESSAGES.network_error);
    this.name = 'ICalFetchError';
    this.code = code;
  }
}

function fetchError(code: ICalFetchErrorCode): ICalFetchError {
  return new ICalFetchError(code, SAFE_FETCH_ERROR_MESSAGES[code]);
}

function normalizeFetchError(error: unknown, fallback: ICalFetchErrorCode): ICalFetchError {
  if (error instanceof ICalFetchError && SAFE_FETCH_ERROR_MESSAGES[error.code] !== undefined) {
    return fetchError(error.code);
  }
  return fetchError(fallback);
}

export type ICalTransportBody = string | Uint8Array | AsyncIterable<Uint8Array>;
export type ICalTransportHeaders = Readonly<Record<string, string>>;

export interface ICalTransportResponse {
  readonly status: number;
  readonly headers: ICalTransportHeaders;
  readonly body: ICalTransportBody;
}

export interface ICalTransportRequest {
  readonly signal: AbortSignal;
  readonly addresses: readonly string[];
}

export type ICalTransport = (
  url: URL,
  request: ICalTransportRequest,
) => Promise<ICalTransportResponse>;

export type ICalHostResolver = (hostname: string) => Promise<readonly string[]>;

export interface ICalFetchOptions {
  readonly allowHttp?: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly resolveHost?: ICalHostResolver;
  readonly transport?: ICalTransport;
}

export interface ICalFetchedFeed {
  readonly body: string;
  readonly finalUrl: string;
}

export interface ICalFetcher {
  fetch(url: string | URL): Promise<ICalFetchedFeed>;
}

const textEncoder = new TextEncoder();

function boundedOption(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum = 0,
): number {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < minimum || value > fallback * 100)
  ) {
    throw new RangeError(`${name} must be a bounded integer.`);
  }
  return value ?? fallback;
}

function cleanAddress(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
}

function ipv4Parts(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function expandIpv6(address: string): readonly number[] | null {
  const normalized = cleanAddress(address).split('%', 1)[0] as string;
  const ipv4Separator = normalized.lastIndexOf(':');
  let value = normalized;
  if (normalized.includes('.') && ipv4Separator > 0) {
    const ipv4 = ipv4Parts(normalized.slice(ipv4Separator + 1));
    if (ipv4 === null) {
      return null;
    }
    const high = ((ipv4[0] as number) << 8) | (ipv4[1] as number);
    const low = ((ipv4[2] as number) << 8) | (ipv4[3] as number);
    value = `${normalized.slice(0, ipv4Separator)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left =
    halves[0] === '' ? [] : (halves[0] as string).split(':').map((part) => parseInt(part, 16));
  const right =
    halves.length === 1 || halves[1] === ''
      ? []
      : (halves[1] as string).split(':').map((part) => parseInt(part, 16));
  if (
    left.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff) ||
    right.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isBlockedAddress(rawAddress: string): boolean {
  const address = cleanAddress(rawAddress);
  const family = isIP(address);
  if (family === 4) {
    const parts = ipv4Parts(address);
    if (parts === null) {
      return true;
    }
    const first = parts[0] as number;
    const second = parts[1] as number;
    const third = parts[2] as number;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 198 && second === 18) ||
      (first === 198 && second === 19) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (family !== 6) {
    return true;
  }
  const parts = expandIpv6(address);
  if (parts === null) {
    return true;
  }
  const first = parts[0] as number;
  const second = parts[1] as number;
  const isUnspecified = parts.every((part) => part === 0);
  const isLoopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && second === 0x0db8;
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  const mappedIpv4 = `${(parts[6] as number) >> 8}.${(parts[6] as number) & 0xff}.${
    (parts[7] as number) >> 8
  }.${(parts[7] as number) & 0xff}`;
  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isDocumentation ||
    (isMappedIpv4 && isBlockedAddress(mappedIpv4))
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata' ||
    normalized === 'metadata.google.internal' ||
    normalized === 'instance-data' ||
    normalized === 'kubernetes.default.svc'
  );
}

function validateUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw fetchError('invalid_url');
  }
  if (url.protocol !== 'https:') {
    throw fetchError('insecure_protocol');
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname.length === 0 ||
    url.hash.length > 0
  ) {
    throw fetchError('invalid_url');
  }
  if (isBlockedHostname(url.hostname)) {
    throw fetchError('blocked_host');
  }
  if (isIP(cleanAddress(url.hostname)) !== 0 && isBlockedAddress(url.hostname)) {
    throw fetchError('blocked_address');
  }
  return url;
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  try {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.map(({ address }) => address);
  } catch {
    throw fetchError('dns_error');
  }
}

function stableAddresses(addresses: readonly string[]): readonly string[] {
  const cleaned = [
    ...new Set(addresses.map(cleanAddress).filter((address) => address.length > 0)),
  ].sort();
  if (cleaned.length === 0 || cleaned.some((address) => isIP(address) === 0)) {
    throw fetchError('dns_error');
  }
  if (cleaned.some(isBlockedAddress)) {
    throw fetchError('blocked_address');
  }
  return cleaned;
}

function canonicalAddresses(addresses: readonly string[]): readonly string[] {
  const cleaned = [
    ...new Set(addresses.map(cleanAddress).filter((address) => address.length > 0)),
  ].sort();
  if (cleaned.length === 0 || cleaned.some((address) => isIP(address) === 0)) {
    throw fetchError('dns_error');
  }
  return cleaned;
}

async function resolveStableAddresses(
  url: URL,
  resolver: ICalHostResolver,
): Promise<readonly string[]> {
  const literal = cleanAddress(url.hostname);
  if (isIP(literal) !== 0) {
    return stableAddresses([literal]);
  }
  try {
    const first = stableAddresses(await resolver(url.hostname));
    const second = canonicalAddresses(await resolver(url.hostname));
    if (
      first.length !== second.length ||
      first.some((address, index) => address !== second[index])
    ) {
      throw fetchError('dns_rebinding');
    }
    return stableAddresses(second);
  } catch (error) {
    throw normalizeFetchError(error, 'dns_error');
  }
}

function headerValue(headers: ICalTransportHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function headersFromIncoming(response: IncomingMessage): ICalTransportHeaders {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(',');
    }
  }
  return headers;
}

function pinnedTransport(url: URL, request: ICalTransportRequest): Promise<ICalTransportResponse> {
  const address = request.addresses[0];
  if (address === undefined) {
    return Promise.reject(fetchError('dns_error'));
  }
  const host = cleanAddress(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const options = {
    hostname: address,
    port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: {
      Host: url.host,
      Accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.1',
    },
  };

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage): void => {
      resolve({
        status: response.statusCode ?? 0,
        headers: headersFromIncoming(response),
        body: response as unknown as AsyncIterable<Uint8Array>,
      });
    };
    const onError = (): void => {
      reject(fetchError('network_error'));
    };
    const requestOptions =
      isIP(host) === 0 && url.protocol === 'https:' ? { ...options, servername: host } : options;
    const clientRequest =
      url.protocol === 'https:'
        ? httpsRequest(requestOptions, onResponse)
        : httpRequest(requestOptions, onResponse);
    clientRequest.once('error', onError);
    const abort = (): void => {
      clientRequest.destroy();
    };
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener('abort', abort, { once: true });
    clientRequest.once('close', () => request.signal.removeEventListener('abort', abort));
    clientRequest.end();
  });
}

async function nextBodyChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) {
    throw fetchError('timeout');
  }
  let removeAbortListener: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(fetchError('timeout'));
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), abort]);
  } finally {
    removeAbortListener?.();
  }
}

async function readBody(
  body: ICalTransportBody,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const addChunk = (chunk: Uint8Array): void => {
    if (!(chunk instanceof Uint8Array)) {
      throw fetchError('network_error');
    }
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw fetchError('body_limit');
    }
    chunks.push(chunk);
  };

  if (signal.aborted) {
    throw fetchError('timeout');
  }
  if (typeof body === 'string') {
    addChunk(textEncoder.encode(body));
  } else if (body instanceof Uint8Array) {
    addChunk(body);
  } else {
    if (
      body === null ||
      typeof body !== 'object' ||
      typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function'
    ) {
      throw fetchError('network_error');
    }
    const iterator = body[Symbol.asyncIterator]();
    let shouldClose = false;
    try {
      while (true) {
        const next = await nextBodyChunk(iterator, signal);
        if (next.done) {
          break;
        }
        addChunk(next.value);
      }
    } catch (error) {
      shouldClose = true;
      throw normalizeFetchError(error, 'network_error');
    } finally {
      if ((shouldClose || signal.aborted) && typeof iterator.return === 'function') {
        try {
          await iterator.return();
        } catch {
          // The original timeout or body error is the only safe operational detail.
        }
      }
    }
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(merged);
  } catch {
    throw fetchError('invalid_encoding');
  }
}

async function discardBody(
  body: ICalTransportBody,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<void> {
  let size = 0;
  const count = (chunk: Uint8Array): void => {
    if (!(chunk instanceof Uint8Array)) {
      throw fetchError('network_error');
    }
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw fetchError('body_limit');
    }
  };
  if (typeof body === 'string') {
    count(textEncoder.encode(body));
    return;
  }
  if (body instanceof Uint8Array) {
    count(body);
    return;
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function'
  ) {
    throw fetchError('network_error');
  }
  const iterator = body[Symbol.asyncIterator]();
  let shouldClose = false;
  try {
    while (true) {
      const next = await nextBodyChunk(iterator, signal);
      if (next.done) {
        return;
      }
      count(next.value);
    }
  } catch (error) {
    shouldClose = true;
    throw normalizeFetchError(error, 'network_error');
  } finally {
    if ((shouldClose || signal.aborted) && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Keep the original bounded fetch error.
      }
    }
  }
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      reject(fetchError('timeout'));
    }, timeoutMs);
  });
  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (didTimeout || (error instanceof ICalFetchError && error.code === 'timeout')) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      throw fetchError('timeout');
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
    throw normalizeFetchError(error, 'network_error');
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (!controller.signal.aborted && didTimeout) {
      controller.abort();
    }
  }
}

function locationHeader(response: ICalTransportResponse): string | undefined {
  return headerValue(response.headers, 'location');
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateResponse(response: ICalTransportResponse): void {
  if (
    typeof response !== 'object' ||
    response === null ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.headers !== 'object' ||
    response.headers === null ||
    Object.entries(response.headers).some(
      ([name, value]) => typeof name !== 'string' || typeof value !== 'string',
    )
  ) {
    throw fetchError('network_error');
  }
}

export function createICalFetcher(options: ICalFetchOptions = {}): ICalFetcher {
  // Kept in the options type for source compatibility; this boundary is HTTPS-only.
  void options.allowHttp;
  const maxRedirects = boundedOption(
    options.maxRedirects,
    ICAL_FETCH_LIMITS.maxRedirects,
    'maxRedirects',
  );
  const timeoutMs = boundedOption(options.timeoutMs, ICAL_FETCH_LIMITS.timeoutMs, 'timeoutMs', 1);
  const maxBodyBytes = boundedOption(
    options.maxBodyBytes,
    ICAL_FETCH_LIMITS.maxBodyBytes,
    'maxBodyBytes',
    1,
  );
  const resolver = options.resolveHost ?? defaultResolveHost;
  const transport = options.transport ?? pinnedTransport;

  return {
    async fetch(input: string | URL): Promise<ICalFetchedFeed> {
      let url = validateUrl(input);
      for (let redirect = 0; ; redirect += 1) {
        const addresses = await withTimeout(() => resolveStableAddresses(url, resolver), timeoutMs);
        let response: ICalTransportResponse;
        try {
          response = await withTimeout(async (signal) => {
            const nextResponse = await transport(url, { signal, addresses });
            validateResponse(nextResponse);
            if (isRedirectStatus(nextResponse.status)) {
              await discardBody(nextResponse.body, maxBodyBytes, signal);
            }
            return nextResponse;
          }, timeoutMs);
        } catch (error) {
          throw normalizeFetchError(error, 'network_error');
        }

        if (isRedirectStatus(response.status)) {
          if (redirect >= maxRedirects) {
            throw fetchError('redirect_limit');
          }
          const location = locationHeader(response);
          if (location === undefined || location.trim().length === 0 || /[\r\n]/u.test(location)) {
            throw fetchError('redirect_location');
          }
          try {
            url = validateUrl(new URL(location.trim(), url));
          } catch (error) {
            if (error instanceof ICalFetchError && error.code !== 'invalid_url') {
              throw error;
            }
            throw fetchError('redirect_location');
          }
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw fetchError('http_error');
        }
        const contentLength = headerValue(response.headers, 'content-length');
        if (contentLength !== undefined) {
          const normalizedLength = contentLength.trim();
          if (!/^\d+$/u.test(normalizedLength)) {
            throw fetchError('network_error');
          }
          const length = Number(normalizedLength);
          if (!Number.isSafeInteger(length) || length > maxBodyBytes) {
            throw fetchError('body_limit');
          }
        }
        return {
          body: await withTimeout(
            (signal) => readBody(response.body, maxBodyBytes, signal),
            timeoutMs,
          ),
          finalUrl: url.href,
        };
      }
    },
  };
}

export async function fetchICalFeed(
  url: string | URL,
  options: ICalFetchOptions = {},
): Promise<ICalFetchedFeed> {
  return createICalFetcher(options).fetch(url);
}

export const createICalFetch = createICalFetcher;
