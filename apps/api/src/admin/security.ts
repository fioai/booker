import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { AdminSession, AdminSessionStore } from './auth.js';
import { AdminHttpError, type AdminHttpRequest } from './contracts.js';
import { validationError } from './serialization.js';
import { SAFE_IDENTIFIER } from './routes.js';
export const SESSION_COOKIE = 'booking_engine_admin_session';
export const CSRF_COOKIE = 'booking_engine_admin_csrf';
export const SAFE_TOKEN = /^[A-Za-z0-9_-]{40,128}$/u;
export const SAFE_COOKIE_NAME = /^[A-Za-z0-9_]{1,64}$/u;
export const MAX_ADMIN_BODY_BYTES = 1_048_576;
export const MAX_ADMIN_OBJECT_KEYS = 256;
export const MAX_ADMIN_ARRAY_ITEMS = 512;
export const MAX_ADMIN_JSON_DEPTH = 16;

export interface ParsedCookies {
  readonly [name: string]: string | undefined;
}

export function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint >= 0x0000 && codePoint <= 0x001f) ||
      (codePoint >= 0x007f && codePoint <= 0x009f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function boundedJsonValue(
  value: unknown,
  depth: number,
  state: { bytes: number; readonly seen: Set<object> },
): boolean {
  if (depth > MAX_ADMIN_JSON_DEPTH) {
    return false;
  }
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value);
    return state.bytes <= MAX_ADMIN_BODY_BYTES;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean' || value === null) {
    return true;
  }
  if (typeof value !== 'object' || (!isPlainRecord(value) && !Array.isArray(value))) {
    return false;
  }
  if (state.seen.has(value)) {
    return false;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ADMIN_ARRAY_ITEMS) {
        return false;
      }
      return value.every((entry) => boundedJsonValue(entry, depth + 1, state));
    }
    const keys = Reflect.ownKeys(value);
    const stringKeys = keys.filter((key): key is string => typeof key === 'string');
    if (keys.length > MAX_ADMIN_OBJECT_KEYS || stringKeys.length !== keys.length) {
      return false;
    }
    return stringKeys.every((key) => {
      if (key.length > 128 || hasControlCharacters(key)) {
        return false;
      }
      return boundedJsonValue(value[key], depth + 1, state);
    });
  } finally {
    state.seen.delete(value);
  }
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value) || !boundedJsonValue(value, 0, { bytes: 0, seen: new Set() })) {
    throw new AdminHttpError(400, 'validation_failed', 'Request validation failed.');
  }
  return value;
}

export function recordForCsrf(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

export function parseCookies(value: string | undefined): ParsedCookies {
  const cookies: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  if (value === undefined || value.length > 8_192) {
    return cookies;
  }
  for (const part of value.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const content = part.slice(separator + 1).trim();
    if (!SAFE_COOKIE_NAME.test(name)) {
      continue;
    }
    if (seen.has(name)) {
      cookies[name] = undefined;
      continue;
    }
    seen.add(name);
    cookies[name] = SAFE_TOKEN.test(content) ? content : undefined;
  }
  return cookies;
}

export function tokenEqual(left: string | undefined, right: string | undefined): boolean {
  if (
    left === undefined ||
    right === undefined ||
    !SAFE_TOKEN.test(left) ||
    !SAFE_TOKEN.test(right)
  ) {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function cookie(
  name: string,
  value: string,
  options: { readonly secure: boolean; readonly httpOnly: boolean; readonly maxAge: number },
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Strict',
    ...(options.httpOnly ? ['HttpOnly'] : []),
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${options.maxAge}`,
  ].join('; ');
}

export function clearedCookie(name: string, secure: boolean, httpOnly: boolean): string {
  return cookie(name, '', { secure, httpOnly, maxAge: 0 });
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function normalizedOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new TypeError('admin origin must be an exact HTTP(S) origin.');
  }
}

function originFromHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const host = headerValue(headers, 'host');
  if (host === undefined || host.length === 0 || /[\s\r\n,]/u.test(host)) {
    return undefined;
  }
  try {
    return new URL(`http://${host}`).origin;
  } catch {
    return undefined;
  }
}

function parseOriginHeader(value: string | undefined): string | undefined {
  if (value === undefined || value === 'null' || /[\s\r\n,]/u.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function sameOrigin(
  headers: Readonly<Record<string, string>> | undefined,
  expectedOrigin: string | undefined,
): boolean {
  const originHeader = headerValue(headers, 'origin');
  if (originHeader !== undefined) {
    const origin = parseOriginHeader(originHeader);
    if (origin === undefined) {
      return false;
    }
    return origin === (expectedOrigin ?? originFromHeaders(headers));
  }
  const referer = headerValue(headers, 'referer');
  if (referer !== undefined) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(referer).origin;
    } catch {
      return false;
    }
    return refererOrigin === (expectedOrigin ?? originFromHeaders(headers));
  }
  return expectedOrigin === undefined;
}

function requestCsrfToken(
  request: AdminHttpRequest,
  body: Record<string, unknown> | undefined,
): string | undefined {
  const header = headerValue(request.headers, 'x-csrf-token');
  const formToken = body?.['csrfToken'];
  const form = typeof formToken === 'string' ? formToken : undefined;
  if (header !== undefined && form !== undefined && !tokenEqual(header, form)) {
    return undefined;
  }
  return header ?? form;
}

export function bodyWithoutCsrf(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(body, 'csrfToken')) {
    return body;
  }
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'csrfToken'));
}

export async function requireCsrf(
  request: AdminHttpRequest,
  session: AdminSession | null,
  sessionStore: AdminSessionStore,
  sessionToken: string | undefined,
  cookies: ParsedCookies,
  body: Record<string, unknown> | undefined,
  expectedOrigin: string | undefined,
): Promise<void> {
  if (!sameOrigin(request.headers, expectedOrigin)) {
    throw new AdminHttpError(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  const cookieToken = cookies[CSRF_COOKIE];
  const candidate = requestCsrfToken(request, body);
  if (!tokenEqual(candidate, cookieToken)) {
    throw new AdminHttpError(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  if (session?.csrfToken !== undefined && !tokenEqual(candidate, session.csrfToken)) {
    throw new AdminHttpError(403, 'csrf_invalid', 'The admin request could not be verified.');
  }
  if (session !== null && session.csrfToken === undefined) {
    const verifyCsrf = sessionStore.verifyCsrf;
    if (
      verifyCsrf === undefined ||
      sessionToken === undefined ||
      !(await verifyCsrf(sessionToken, candidate as string))
    ) {
      throw new AdminHttpError(403, 'csrf_invalid', 'The admin request could not be verified.');
    }
  }
}

export function requireAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const invalid = Object.keys(record).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    validationError(invalid.slice(0, 32).map((field) => ({ field, code: 'unknown_field' })));
  }
}

export function requireNoBodyFields(body: Record<string, unknown>): void {
  if (Object.keys(body).length > 0) {
    validationError([{ field: 'body', code: 'unknown_field' }]);
  }
}

export function requirePrivateRead(session: AdminSession): void {
  if (session.role === 'viewer') {
    throw new AdminHttpError(403, 'forbidden', 'This admin role is not permitted.');
  }
}

export function requireMutation(session: AdminSession): void {
  if (session.role === 'viewer') {
    throw new AdminHttpError(403, 'forbidden', 'This admin role is not permitted.');
  }
}

export function requireBookingMutation(session: AdminSession): void {
  if (session.role !== 'owner' && session.role !== 'admin') {
    throw new AdminHttpError(403, 'forbidden', 'This admin role is not permitted.');
  }
}

export async function requireSession(
  store: AdminSessionStore,
  request: AdminHttpRequest,
): Promise<{
  readonly token: string;
  readonly session: AdminSession;
  readonly cookies: ParsedCookies;
}> {
  const cookies = parseCookies(headerValue(request.headers, 'cookie'));
  const token = cookies[SESSION_COOKIE];
  if (token === undefined) {
    throw new AdminHttpError(401, 'invalid_session', 'A valid admin session is required.');
  }
  const session = await store.get(token);
  if (session === null) {
    throw new AdminHttpError(401, 'invalid_session', 'A valid admin session is required.');
  }
  return { token, session, cookies };
}

export { SAFE_IDENTIFIER };
