/** Provider-neutral payment contracts and bounded state rules. */

export type MoneyMinor = number & { readonly __brand: 'MoneyMinor' };

export type PaymentStateV1 = 'created' | 'open' | 'paid' | 'failed' | 'expired' | 'rejected';

export type PaymentEventOutcomeV1 = 'succeeded' | 'failed' | 'expired';

export interface PaymentCheckoutRequestV1 {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly requestId: string;
  readonly holdId: string;
  readonly amountMinor: MoneyMinor;
  readonly currency: string;
  /** Opaque revision of the immutable quote; it is never supplied by the browser. */
  readonly quoteRevision: string;
  readonly checkoutExpiresAt: string;
}

export interface PaymentCheckoutSessionV1 {
  readonly providerName: string;
  readonly providerSessionId: string;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
}

export interface PaymentOrganizationScopeV1 {
  readonly organizationId: string;
}

export interface PaymentProviderRegistrationV1 {
  readonly providerName: string;
  readonly providerAccountId: string;
}

export interface PaymentCheckoutPreparationV1 {
  readonly checkoutId: string;
  readonly providerName: string;
  readonly providerAccountId: string;
  readonly providerSessionId: string | null;
  readonly state: Extract<PaymentStateV1, 'created' | 'open'>;
  readonly request: PaymentCheckoutRequestV1;
}

export interface PaymentWebhookMetadataV1 {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly requestId: string;
  readonly holdId: string;
  readonly quoteRevision: string;
}

export interface PaymentWebhookEventV1 {
  readonly providerName: string;
  readonly providerEventId: string;
  readonly providerAccountId: string;
  readonly eventType: PaymentEventOutcomeV1;
  readonly providerSessionId: string;
  readonly providerPaymentId: string | null;
  readonly amountMinor: MoneyMinor;
  readonly currency: string;
  readonly metadata: PaymentWebhookMetadataV1;
  readonly occurredAt: string;
}

export interface PaymentCheckoutRecordV1 {
  readonly checkoutId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly requestId: string;
  readonly holdId: string;
  readonly providerName: string;
  readonly providerAccountId: string;
  readonly providerSessionId: string | null;
  readonly providerPaymentId: string | null;
  readonly amountMinor: MoneyMinor;
  readonly currency: string;
  readonly quoteRevision: string;
  readonly state: PaymentStateV1;
  readonly failureCode: string | null;
  readonly checkoutExpiresAt: string;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PaymentWebhookProcessingStatusV1 = 'processed' | 'duplicate' | 'ignored' | 'rejected';

export interface PaymentWebhookProcessingResultV1 {
  readonly status: PaymentWebhookProcessingStatusV1;
  readonly payment: PaymentCheckoutRecordV1 | null;
  readonly code?: string;
}

export interface PaymentCheckoutStoreV1 {
  prepareCheckout(
    scope: PaymentOrganizationScopeV1,
    propertyId: string,
    requestId: string,
    provider: PaymentProviderRegistrationV1,
  ): Promise<PaymentCheckoutPreparationV1>;
  attachProviderSession(
    scope: PaymentOrganizationScopeV1,
    propertyId: string,
    checkoutId: string,
    session: PaymentCheckoutSessionV1,
  ): Promise<PaymentCheckoutRecordV1>;
  processWebhookEvent(event: PaymentWebhookEventV1): Promise<PaymentWebhookProcessingResultV1>;
}

export interface PaymentContractErrorV1 {
  readonly field: string;
  readonly code:
    | 'invalid_object'
    | 'invalid_identifier'
    | 'invalid_amount'
    | 'invalid_currency'
    | 'invalid_revision'
    | 'invalid_timestamp'
    | 'unknown_field';
  readonly message: string;
}

export type PaymentContractResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly PaymentContractErrorV1[] };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CHECKOUT_FIELDS = [
  'organizationId',
  'propertyId',
  'requestId',
  'holdId',
  'amountMinor',
  'currency',
  'quoteRevision',
  'checkoutExpiresAt',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractError(
  field: string,
  code: PaymentContractErrorV1['code'],
  message: string,
): PaymentContractErrorV1 {
  return { field, code, message };
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) {
    return false;
  }
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

/** Canonicalizes only the fields the server may pass to a payment provider. */
export function createPaymentCheckoutRequestV1(
  input: unknown,
): PaymentContractResultV1<PaymentCheckoutRequestV1> {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [contractError('checkout', 'invalid_object', 'checkout request must be an object.')],
    };
  }

  const errors: PaymentContractErrorV1[] = [];
  if (
    Object.keys(input).length !== CHECKOUT_FIELDS.length ||
    CHECKOUT_FIELDS.some((field) => !Object.hasOwn(input, field))
  ) {
    errors.push(contractError('checkout', 'unknown_field', 'checkout request fields are bounded.'));
  }

  const identifiers = ['organizationId', 'propertyId', 'requestId', 'holdId'] as const;
  for (const field of identifiers) {
    const value = input[field];
    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
      errors.push(
        contractError(field, 'invalid_identifier', `${field} is not a valid identifier.`),
      );
    }
  }

  const amountMinor = input['amountMinor'];
  if (
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    amountMinor > 1_000_000_000
  ) {
    errors.push(
      contractError('amountMinor', 'invalid_amount', 'amountMinor is outside the bound.'),
    );
  }

  const currency = input['currency'];
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)) {
    errors.push(
      contractError('currency', 'invalid_currency', 'currency must be an uppercase code.'),
    );
  }

  const quoteRevision = input['quoteRevision'];
  if (typeof quoteRevision !== 'string' || !REVISION_PATTERN.test(quoteRevision)) {
    errors.push(
      contractError('quoteRevision', 'invalid_revision', 'quote revision is not bounded.'),
    );
  }

  const checkoutExpiresAt = input['checkoutExpiresAt'];
  if (!isValidTimestamp(checkoutExpiresAt)) {
    errors.push(
      contractError(
        'checkoutExpiresAt',
        'invalid_timestamp',
        'checkout expiry is not a timestamp.',
      ),
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors: Object.freeze(errors) };
  }

  return {
    ok: true,
    value: Object.freeze({
      organizationId: input['organizationId'] as string,
      propertyId: input['propertyId'] as string,
      requestId: input['requestId'] as string,
      holdId: input['holdId'] as string,
      amountMinor: amountMinor as MoneyMinor,
      currency: currency as string,
      quoteRevision: quoteRevision as string,
      checkoutExpiresAt: checkoutExpiresAt as string,
    }),
  };
}

export type PaymentStateTransitionResultV1 =
  | { readonly ok: true; readonly value: PaymentStateV1 }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'terminal_state'; readonly state: PaymentStateV1 };
    };

/** Applies monotonic payment state rules for post-approval payment recording. */
export function paymentStateTransitionV1(
  state: PaymentStateV1,
  outcome: PaymentEventOutcomeV1,
): PaymentStateTransitionResultV1 {
  if (state === 'paid') {
    return { ok: true, value: 'paid' };
  }
  if (state === 'failed' || state === 'expired' || state === 'rejected') {
    return {
      ok: false,
      error: { code: 'terminal_state', state },
    };
  }
  if (outcome === 'succeeded') {
    return { ok: true, value: 'paid' };
  }
  return { ok: true, value: outcome };
}

/** Legacy-compatible aliases retained for composition boundaries. */
export type CheckoutRequest = PaymentCheckoutRequestV1;

export interface CheckoutSession extends PaymentCheckoutSessionV1 {
  readonly providerSessionId: string;
}

export interface PaymentProvider {
  readonly providerName: string;
  readonly providerAccountId?: string;
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  readonly verifyWebhook?: (
    rawBody: Uint8Array | string,
    signatureHeader: string,
  ) => PaymentWebhookEventV1;
}

export interface PaymentCheckoutServiceV1 {
  startCheckout(
    scope: PaymentOrganizationScopeV1,
    propertyId: string,
    requestId: string,
  ): Promise<CheckoutSession>;
  handleWebhook(
    rawBody: Uint8Array | string,
    signatureHeader: string,
  ): Promise<PaymentWebhookProcessingResultV1>;
}

export interface PaymentCheckoutServiceDependenciesV1 {
  readonly store: PaymentCheckoutStoreV1;
  readonly provider: PaymentProvider;
}

/** Composes server-owned preparation, provider creation, and transactional webhook handling. */
export function createPaymentCheckoutServiceV1(
  dependencies: PaymentCheckoutServiceDependenciesV1,
): PaymentCheckoutServiceV1 {
  const providerAccountId = dependencies.provider.providerAccountId;
  if (typeof providerAccountId !== 'string' || providerAccountId.length === 0) {
    throw new TypeError('payment provider account is required at composition time.');
  }
  return {
    async startCheckout(scope, propertyId, requestId): Promise<CheckoutSession> {
      const prepared = await dependencies.store.prepareCheckout(scope, propertyId, requestId, {
        providerName: dependencies.provider.providerName,
        providerAccountId,
      });
      if (
        prepared.providerName !== dependencies.provider.providerName ||
        prepared.providerAccountId !== providerAccountId
      ) {
        throw new Error('payment provider preparation did not match composition.');
      }
      const session = await dependencies.provider.createCheckoutSession(prepared.request);
      if (session.providerName !== dependencies.provider.providerName) {
        throw new Error('payment provider session did not match composition.');
      }
      await dependencies.store.attachProviderSession(
        scope,
        propertyId,
        prepared.checkoutId,
        session,
      );
      return session;
    },
    async handleWebhook(rawBody, signatureHeader): Promise<PaymentWebhookProcessingResultV1> {
      const verifyWebhook = dependencies.provider.verifyWebhook;
      if (verifyWebhook === undefined) {
        throw new TypeError('payment provider webhook verification is not configured.');
      }
      const event = verifyWebhook(rawBody, signatureHeader);
      if (event.providerName !== dependencies.provider.providerName) {
        throw new Error('payment webhook provider did not match composition.');
      }
      return dependencies.store.processWebhookEvent(event);
    },
  };
}
