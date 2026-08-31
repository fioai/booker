import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  PaymentCheckoutRequest,
  PaymentCheckoutSession,
  MoneyMinor,
  PaymentProvider,
  PaymentWebhookEvent,
} from '@booking-engine/payments';
import { createPaymentCheckoutRequest } from '@booking-engine/payments';

const DEFAULT_MAX_BODY_BYTES = 262_144;
const MAX_ALLOWED_BODY_BYTES = 1_048_576;
const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_TIMESTAMP_TOLERANCE_SECONDS = 600;
const MAX_SIGNATURE_HEADER_LENGTH = 2_048;
const ACCOUNT_PATTERN = /^acct_[A-Za-z0-9_]{1,63}$/u;
const EVENT_PATTERN = /^evt_[A-Za-z0-9_]{1,254}$/u;
const SESSION_PATTERN = /^cs_[A-Za-z0-9_]{1,254}$/u;
const PAYMENT_PATTERN = /^pi_[A-Za-z0-9_]{1,254}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

export type StripeWebhookErrorCode =
  | 'invalid_configuration'
  | 'body_too_large'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'stale_signature'
  | 'invalid_payload'
  | 'unsupported_event'
  | 'account_mismatch';

export class StripeWebhookError extends Error {
  readonly code: StripeWebhookErrorCode;

  constructor(code: StripeWebhookErrorCode, message: string) {
    super(message);
    this.name = 'StripeWebhookError';
    this.code = code;
  }
}

export interface StripeCheckoutAdapterOptions {
  readonly mode: 'test';
  readonly accountId: string;
  readonly webhookSecret: string;
  /** Optional test key is accepted only when it has a Stripe test prefix. */
  readonly secretKey?: string;
  readonly maxBodyBytes?: number;
  readonly timestampToleranceSeconds?: number;
  readonly clock?: () => Date;
}

export interface StripeSignatureVerificationOptions {
  readonly now?: Date;
  readonly toleranceSeconds?: number;
  readonly maxBodyBytes?: number;
}

export interface StripeSignatureVerificationResult {
  readonly timestamp: number;
}

export interface StripePaymentProvider extends PaymentProvider {
  readonly providerName: 'stripe';
  readonly providerAccountId: string;
  verifyWebhook(rawBody: Uint8Array | string, signatureHeader: string): PaymentWebhookEvent;
}

function bodyBytes(rawBody: Uint8Array | string): Uint8Array {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : new Uint8Array(rawBody);
}

function boundedBodyBytes(rawBody: Uint8Array | string, maxBodyBytes: number): Uint8Array {
  const body = bodyBytes(rawBody);
  if (body.byteLength > maxBodyBytes) {
    throw new StripeWebhookError(
      'body_too_large',
      'Stripe webhook body exceeded the configured bound.',
    );
  }
  return body;
}

function validateBoundedInteger(value: number, maximum: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new StripeWebhookError('invalid_configuration', message);
  }
  return value;
}

function validateAdapterOptions(options: StripeCheckoutAdapterOptions): {
  readonly accountId: string;
  readonly webhookSecret: string;
  readonly maxBodyBytes: number;
  readonly timestampToleranceSeconds: number;
  readonly clock: () => Date;
} {
  if (options.mode !== 'test') {
    throw new StripeWebhookError(
      'invalid_configuration',
      'Stripe payment adapter is restricted to test mode.',
    );
  }
  if (typeof options.accountId !== 'string' || !ACCOUNT_PATTERN.test(options.accountId)) {
    throw new StripeWebhookError(
      'invalid_configuration',
      'Stripe account configuration is invalid.',
    );
  }
  if (
    typeof options.webhookSecret !== 'string' ||
    options.webhookSecret.length === 0 ||
    options.webhookSecret.length > 256 ||
    hasControlCharacters(options.webhookSecret)
  ) {
    throw new StripeWebhookError(
      'invalid_configuration',
      'Stripe webhook configuration is invalid.',
    );
  }
  if (options.secretKey !== undefined && !options.secretKey.startsWith('sk_test_')) {
    throw new StripeWebhookError(
      'invalid_configuration',
      'Stripe payment adapter is restricted to test mode.',
    );
  }
  const maxBodyBytes = validateBoundedInteger(
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    MAX_ALLOWED_BODY_BYTES,
    'Stripe webhook body bound is invalid.',
  );
  const timestampToleranceSeconds = validateBoundedInteger(
    options.timestampToleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
    MAX_TIMESTAMP_TOLERANCE_SECONDS,
    'Stripe webhook timestamp tolerance is invalid.',
  );
  const clock = options.clock ?? (() => new Date());
  return {
    accountId: options.accountId,
    webhookSecret: options.webhookSecret,
    maxBodyBytes,
    timestampToleranceSeconds,
    clock,
  };
}

function parseSignatureHeader(signatureHeader: string): {
  readonly timestamp: number;
  readonly digests: readonly string[];
} {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    throw new StripeWebhookError('malformed_signature', 'Stripe webhook signature is malformed.');
  }
  if (signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH) {
    throw new StripeWebhookError('malformed_signature', 'Stripe webhook signature is malformed.');
  }
  let timestamp: number | undefined;
  const digests: string[] = [];
  const fields = signatureHeader.split(',');
  if (fields.length > 16) {
    throw new StripeWebhookError('malformed_signature', 'Stripe webhook signature is malformed.');
  }
  for (const field of fields) {
    const separator = field.indexOf('=');
    if (separator <= 0 || separator === field.length - 1) {
      throw new StripeWebhookError('malformed_signature', 'Stripe webhook signature is malformed.');
    }
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/u.test(value)) {
        throw new StripeWebhookError(
          'malformed_signature',
          'Stripe webhook signature is malformed.',
        );
      }
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!/^[a-f0-9]{64}$/u.test(value) || digests.length >= 8) {
        throw new StripeWebhookError(
          'malformed_signature',
          'Stripe webhook signature is malformed.',
        );
      }
      digests.push(value);
    }
  }
  if (timestamp === undefined || digests.length === 0) {
    throw new StripeWebhookError('malformed_signature', 'Stripe webhook signature is malformed.');
  }
  return { timestamp, digests };
}

function isEqualDigest(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, 'hex');
  const candidateBytes = Buffer.from(candidate, 'hex');
  return (
    expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes)
  );
}

export function verifyStripeWebhookSignature(
  rawBody: Uint8Array | string,
  signatureHeader: string,
  webhookSecret: string,
  options: StripeSignatureVerificationOptions = {},
): StripeSignatureVerificationResult {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_ALLOWED_BODY_BYTES ||
    !Number.isSafeInteger(toleranceSeconds) ||
    toleranceSeconds < 1 ||
    toleranceSeconds > MAX_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    throw new StripeWebhookError('invalid_configuration', 'Stripe webhook bounds are invalid.');
  }
  const body = boundedBodyBytes(rawBody, maxBodyBytes);
  const parsed = parseSignatureHeader(signatureHeader);
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    throw new StripeWebhookError(
      'invalid_configuration',
      'Stripe webhook configuration is invalid.',
    );
  }
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    throw new StripeWebhookError(
      'stale_signature',
      'Stripe webhook signature is outside the time bound.',
    );
  }
  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, 'utf8'),
    Buffer.from(body),
  ]);
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  if (!parsed.digests.some((digest) => isEqualDigest(expected, digest))) {
    throw new StripeWebhookError('invalid_signature', 'Stripe webhook signature is invalid.');
  }
  return { timestamp: parsed.timestamp };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string, pattern: RegExp, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new StripeWebhookError('invalid_payload', `Stripe webhook ${field} is invalid.`);
  }
  return value;
}

function identifierField(value: unknown, field: string): string {
  return stringField(value, field, IDENTIFIER_PATTERN, 64);
}

function amountField(value: unknown): MoneyMinor {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
  ) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook amount is invalid.');
  }
  return value as MoneyMinor;
}

function metadataFields(value: unknown): PaymentWebhookEvent['metadata'] {
  if (!record(value)) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook metadata is invalid.');
  }
  return {
    organizationId: identifierField(value['organization_id'], 'metadata'),
    propertyId: identifierField(value['property_id'], 'metadata'),
    requestId: identifierField(value['request_id'], 'metadata'),
    holdId: identifierField(value['hold_id'], 'metadata'),
    quoteRevision: stringField(value['quote_revision'], 'metadata', REVISION_PATTERN, 128),
  };
}

function eventObject(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value['data']) || !record(value['data']['object'])) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook payload is invalid.');
  }
  return value['data']['object'];
}

function eventType(value: unknown): 'succeeded' | 'failed' | 'expired' {
  if (value === 'checkout.session.completed' || value === 'payment_intent.succeeded') {
    return 'succeeded';
  }
  if (
    value === 'checkout.session.expired' ||
    value === 'payment_intent.payment_failed' ||
    value === 'checkout.session.async_payment_failed'
  ) {
    return value === 'checkout.session.expired' ? 'expired' : 'failed';
  }
  throw new StripeWebhookError('unsupported_event', 'Stripe webhook event type is unsupported.');
}

function eventCreated(value: unknown): string {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 4_102_444_800
  ) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook timestamp is invalid.');
  }
  const created = new Date(value * 1000);
  return created.toISOString();
}

function parseWebhookEvent(rawBody: Uint8Array, expectedAccountId: string): PaymentWebhookEvent {
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook payload is invalid.');
  }
  if (!record(parsed)) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook payload is invalid.');
  }
  const providerAccountId = parsed['account'] ?? expectedAccountId;
  if (typeof providerAccountId !== 'string' || providerAccountId !== expectedAccountId) {
    throw new StripeWebhookError('account_mismatch', 'Stripe webhook account does not match.');
  }
  if (parsed['livemode'] === true) {
    throw new StripeWebhookError(
      'invalid_payload',
      'Stripe webhook is outside the test mode adapter bound.',
    );
  }
  const kind = eventType(parsed['type']);
  const object = eventObject(parsed);
  const sessionId =
    parsed['type'] === 'payment_intent.succeeded' ||
    parsed['type'] === 'payment_intent.payment_failed'
      ? object['metadata'] && record(object['metadata'])
        ? object['metadata']['provider_session_id']
        : undefined
      : object['id'];
  const providerSessionId = stringField(sessionId, 'session', SESSION_PATTERN, 255);
  const providerPaymentId =
    parsed['type']?.toString().startsWith('payment_intent.') === true
      ? stringField(object['id'], 'payment', PAYMENT_PATTERN, 255)
      : object['payment_intent'] === null || object['payment_intent'] === undefined
        ? null
        : stringField(object['payment_intent'], 'payment', PAYMENT_PATTERN, 255);
  const metadata = metadataFields(object['metadata']);
  const amountValue = object['amount_total'] ?? object['amount_received'] ?? object['amount'];
  const currency = object['currency'];
  if (typeof currency !== 'string' || !/^[a-zA-Z]{3}$/u.test(currency)) {
    throw new StripeWebhookError('invalid_payload', 'Stripe webhook currency is invalid.');
  }
  if (parsed['type'] === 'checkout.session.completed' && object['payment_status'] !== 'paid') {
    throw new StripeWebhookError('invalid_payload', 'Stripe Checkout payment is not paid.');
  }
  return Object.freeze({
    providerName: 'stripe',
    providerEventId: stringField(parsed['id'], 'event', EVENT_PATTERN, 255),
    providerAccountId,
    eventType: kind,
    providerSessionId,
    providerPaymentId,
    amountMinor: amountField(amountValue),
    currency: currency.toUpperCase(),
    metadata,
    occurredAt: eventCreated(parsed['created']),
  });
}

export function createStripeCheckoutAdapter(
  options: StripeCheckoutAdapterOptions,
): StripePaymentProvider {
  const validated = validateAdapterOptions(options);
  return {
    providerName: 'stripe',
    providerAccountId: validated.accountId,
    async createCheckoutSession(request: PaymentCheckoutRequest): Promise<PaymentCheckoutSession> {
      const canonical = createPaymentCheckoutRequest(request);
      if (!canonical.ok) {
        throw new StripeWebhookError('invalid_payload', 'Stripe checkout request is invalid.');
      }
      const providerSessionId = `cs_test_${createHash('sha256')
        .update(JSON.stringify(canonical.value))
        .digest('hex')
        .slice(0, 24)}`;
      return Object.freeze({
        providerName: 'stripe',
        providerSessionId,
        checkoutUrl: `https://checkout.stripe.test/${providerSessionId}`,
        expiresAt: canonical.value.checkoutExpiresAt,
      });
    },
    verifyWebhook(rawBody, signatureHeader): PaymentWebhookEvent {
      const body = boundedBodyBytes(rawBody, validated.maxBodyBytes);
      verifyStripeWebhookSignature(body, signatureHeader, validated.webhookSecret, {
        now: validated.clock(),
        toleranceSeconds: validated.timestampToleranceSeconds,
        maxBodyBytes: validated.maxBodyBytes,
      });
      return parseWebhookEvent(body, validated.accountId);
    },
  };
}
