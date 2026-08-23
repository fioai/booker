import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export type AdminRoleV1 = 'owner' | 'admin' | 'manager' | 'viewer';

export interface AdminCredentialRecordV1 {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: AdminRoleV1;
  /** Only a password verifier is accepted at the application boundary. */
  readonly passwordHash: string;
}

export interface AdminCredentialStoreV1 {
  findByEmail(email: string): Promise<AdminCredentialRecordV1 | null>;
}

export interface AdminSessionUserV1 {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: AdminRoleV1;
}

export interface AdminSessionV1 extends AdminSessionUserV1 {
  /** Present for the in-memory adapter; persistent adapters verify it by digest. */
  readonly csrfToken?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
}

export interface AdminSessionStoreOptionsV1 {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly maxSessions?: number;
}

export interface AdminSessionTicketV1 {
  readonly token: string;
  readonly csrfToken: string;
  readonly session: AdminSessionV1;
}

export interface AdminSessionStoreV1 {
  create(user: AdminSessionUserV1): AdminSessionTicketV1 | Promise<AdminSessionTicketV1>;
  get(token: string): AdminSessionV1 | null | Promise<AdminSessionV1 | null>;
  destroy(token: string): void | Promise<void>;
  verifyCsrf?(token: string, candidate: string): boolean | Promise<boolean>;
}

export interface AdminInMemorySessionStoreV1 extends AdminSessionStoreV1 {
  create(user: AdminSessionUserV1): AdminSessionTicketV1;
  get(token: string): AdminSessionV1 | null;
  destroy(token: string): void;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 1_000;
const MAX_SESSIONS = 10_000;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
// A verifier with no corresponding account keeps the normal credential-failure path on the
// same scrypt primitive without embedding a fallback password or storing plaintext.
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$AQEBAQEBAQEBAQEBAQEBAQ$hxzWooh97pINo1zW2P6ijE93mcH5kQmXCl6nsvjxkpw';

function deriveScryptKey(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 32 * 1024 * 1024 },
      (error, derived) => {
        if (error !== null) {
          reject(error);
          return;
        }
        if (!Buffer.isBuffer(derived)) {
          reject(new TypeError('scrypt returned an invalid derived key.'));
          return;
        }
        resolve(derived);
      },
    );
  });
}

function hasUnsafeControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function validateIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a bounded identifier.`);
  }
}

export function normalizeAdminEmailV1(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 254 ||
    hasUnsafeControlCharacters(value)
  ) {
    throw new TypeError('email must be a bounded string.');
  }
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new TypeError('email must be a valid address.');
  }
  return email;
}

function validatePassword(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH ||
    hasUnsafeControlCharacters(value)
  ) {
    throw new TypeError(
      `password must contain ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
}

export function validateAdminSessionUserV1(user: AdminSessionUserV1): AdminSessionUserV1 {
  validateIdentifier(user?.id, 'user id');
  validateIdentifier(user?.organizationId, 'organization id');
  const email = normalizeAdminEmailV1(user?.email);
  if (
    user.role !== 'owner' &&
    user.role !== 'admin' &&
    user.role !== 'manager' &&
    user.role !== 'viewer'
  ) {
    throw new TypeError('user role is invalid.');
  }
  return Object.freeze({
    id: user.id,
    organizationId: user.organizationId,
    email,
    role: user.role,
  });
}

function encodeToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export async function hashOwnerPasswordV1(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derived = await deriveScryptKey(password, salt, SCRYPT_KEY_LENGTH);
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

function parsePasswordHash(value: string):
  | {
      readonly salt: Buffer;
      readonly derived: Buffer;
    }
  | undefined {
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return undefined;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltText = parts[4];
  const derivedText = parts[5];
  if (
    n !== SCRYPT_N ||
    r !== SCRYPT_R ||
    p !== SCRYPT_P ||
    saltText === undefined ||
    derivedText === undefined ||
    !/^[A-Za-z0-9_-]{22}$/u.test(saltText) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(derivedText)
  ) {
    return undefined;
  }
  const salt = Buffer.from(saltText, 'base64url');
  const derived = Buffer.from(derivedText, 'base64url');
  if (salt.length !== SCRYPT_SALT_LENGTH || derived.length !== SCRYPT_KEY_LENGTH) {
    return undefined;
  }
  return { salt, derived };
}

export async function verifyOwnerPasswordV1(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    validatePassword(password);
    if (typeof passwordHash !== 'string' || passwordHash.length > 256) {
      return false;
    }
    const parsed = parsePasswordHash(passwordHash);
    if (parsed === undefined) {
      return false;
    }
    const derived = await deriveScryptKey(password, parsed.salt, SCRYPT_KEY_LENGTH);
    return timingSafeEqual(parsed.derived, derived);
  } catch {
    return false;
  }
}

export async function authenticateOwnerV1(
  credentials: AdminCredentialStoreV1,
  email: unknown,
  password: unknown,
): Promise<AdminSessionUserV1 | null> {
  if (typeof password !== 'string') {
    return null;
  }
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeAdminEmailV1(email);
  } catch {
    await verifyOwnerPasswordV1(password, DUMMY_PASSWORD_HASH);
    return null;
  }
  try {
    const record = await credentials.findByEmail(normalizedEmail);
    const valid = await verifyOwnerPasswordV1(
      password,
      record !== null && typeof record.passwordHash === 'string'
        ? record.passwordHash
        : DUMMY_PASSWORD_HASH,
    );
    if (
      record === null ||
      typeof record.email !== 'string' ||
      record.email.trim().toLowerCase() !== normalizedEmail
    ) {
      return null;
    }
    const user = validateAdminSessionUserV1(record);
    return valid ? user : null;
  } catch {
    await verifyOwnerPasswordV1(password, DUMMY_PASSWORD_HASH);
    return null;
  }
}

export function validateAdminSessionStoreOptionsV1(options: AdminSessionStoreOptionsV1): {
  readonly ttlMs: number;
  readonly maxSessions: number;
  readonly clock: () => number;
} {
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_SESSION_TTL_MS) {
    throw new RangeError('session ttl must be a bounded duration from one second to 24 hours.');
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS) {
    throw new RangeError(`session capacity must be an integer from 1 to ${MAX_SESSIONS}.`);
  }
  const clock = options.clock ?? (() => Date.now());
  if (typeof clock !== 'function') {
    throw new TypeError('session clock must be a function.');
  }
  return { ttlMs, maxSessions, clock };
}

export function createAdminSessionStoreV1(
  options: AdminSessionStoreOptionsV1 = {},
): AdminInMemorySessionStoreV1 {
  const { ttlMs, maxSessions, clock } = validateAdminSessionStoreOptionsV1(options);
  const sessions = new Map<string, AdminSessionV1>();

  function prune(now: number): void {
    for (const [digest, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(digest);
      }
    }
  }

  function oldestDigest(): string | undefined {
    let oldest: { readonly digest: string; readonly lastSeenAt: number } | undefined;
    for (const [digest, session] of sessions) {
      if (oldest === undefined || session.lastSeenAt < oldest.lastSeenAt) {
        oldest = { digest, lastSeenAt: session.lastSeenAt };
      }
    }
    return oldest?.digest;
  }

  return {
    create(user): AdminSessionTicketV1 {
      const validatedUser = validateAdminSessionUserV1(user);
      const now = clock();
      if (!Number.isFinite(now)) {
        throw new TypeError('session clock must return a finite timestamp.');
      }
      prune(now);
      while (sessions.size >= maxSessions) {
        const digest = oldestDigest();
        if (digest === undefined) {
          break;
        }
        sessions.delete(digest);
      }
      const token = encodeToken();
      const csrfToken = encodeToken();
      const expiresAt = now + ttlMs;
      if (!Number.isFinite(expiresAt)) {
        throw new TypeError('session expiration must be finite.');
      }
      const session = Object.freeze({
        ...validatedUser,
        csrfToken,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
      });
      sessions.set(tokenDigest(token), session);
      return Object.freeze({ token, csrfToken, session });
    },

    get(token): AdminSessionV1 | null {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        return null;
      }
      let now: number;
      try {
        now = clock();
      } catch {
        return null;
      }
      if (!Number.isFinite(now)) {
        return null;
      }
      const digest = tokenDigest(token);
      const current = sessions.get(digest);
      if (current === undefined || current.expiresAt <= now) {
        sessions.delete(digest);
        return null;
      }
      const session = Object.freeze({ ...current, lastSeenAt: now });
      sessions.set(digest, session);
      return session;
    },

    destroy(token): void {
      if (typeof token === 'string' && TOKEN_PATTERN.test(token)) {
        sessions.delete(tokenDigest(token));
      }
    },
  };
}

export const ADMIN_SESSION_TTL_MS_V1 = DEFAULT_SESSION_TTL_MS;
export const ADMIN_PASSWORD_MIN_LENGTH_V1 = PASSWORD_MIN_LENGTH;
export const ADMIN_PASSWORD_MAX_LENGTH_V1 = PASSWORD_MAX_LENGTH;
