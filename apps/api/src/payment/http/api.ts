import type {
  PaymentCheckoutSession,
  PaymentCheckoutService,
  PaymentOrganizationScope,
} from '@booking-engine/payments';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const WEBHOOK_PATH = '/v1/payments/stripe/webhook';

export interface PaymentHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly rawBody?: Uint8Array;
}

export interface PaymentHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface PaymentHttpApiOptions {
  /** Tenant scope is supplied by the trusted composition boundary, never the browser. */
  readonly scope: PaymentOrganizationScope;
}

export interface PaymentHttpApi {
  handle(request: PaymentHttpRequest): Promise<PaymentHttpResponse>;
}

class PaymentHttpError extends Error {
  readonly status: number;
  readonly code:
    | 'invalid_input'
    | 'payment_unavailable'
    | 'webhook_invalid'
    | 'route_not_found'
    | 'method_not_allowed'
    | 'internal_error';

  constructor(status: number, code: PaymentHttpError['code'], message: string) {
    super(message);
    this.name = 'PaymentHttpError';
    this.status = status;
    this.code = code;
  }
}

function errorResponse(error: unknown): PaymentHttpResponse {
  if (error instanceof PaymentHttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (
    code === 'invalid_signature' ||
    code === 'stale_signature' ||
    code === 'malformed_signature' ||
    code === 'body_too_large' ||
    code === 'invalid_payload' ||
    code === 'unsupported_event' ||
    code === 'account_mismatch'
  ) {
    return {
      status: 400,
      body: { error: { code: 'webhook_invalid', message: 'Webhook could not be verified.' } },
    };
  }
  if (
    code === 'payment_request_not_found' ||
    code === 'payment_request_not_approved' ||
    code === 'payment_occupancy_unavailable' ||
    code === 'payment_retry_exhausted' ||
    code === 'payment_event_rejected'
  ) {
    return {
      status: 409,
      body: {
        error: { code: 'payment_unavailable', message: 'Payment checkout could not be started.' },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: { code: 'internal_error', message: 'The payment request could not be completed.' },
    },
  };
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function route(
  path: string,
):
  | { readonly kind: 'checkout'; readonly propertyId: string; readonly requestId: string }
  | { readonly kind: 'webhook' }
  | undefined {
  let url: URL;
  try {
    url = new URL(path, 'https://booking-engine.invalid');
  } catch {
    return undefined;
  }
  if (url.pathname === WEBHOOK_PATH) {
    return { kind: 'webhook' };
  }
  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  if (
    parts.length !== 6 ||
    parts[0] !== 'v1' ||
    parts[1] !== 'properties' ||
    parts[3] !== 'booking-requests' ||
    parts[5] !== 'checkout'
  ) {
    return undefined;
  }
  let propertyId: string;
  let requestId: string;
  try {
    propertyId = decodeURIComponent(parts[2] as string);
    requestId = decodeURIComponent(parts[4] as string);
  } catch {
    return undefined;
  }
  if (!IDENTIFIER_PATTERN.test(propertyId) || !IDENTIFIER_PATTERN.test(requestId)) {
    return undefined;
  }
  return { kind: 'checkout', propertyId, requestId };
}

function emptyBody(body: unknown): boolean {
  return (
    body === undefined ||
    (typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0)
  );
}

function checkoutResponse(session: PaymentCheckoutSession): PaymentHttpResponse {
  return {
    status: 201,
    body: {
      provider: session.providerName,
      providerSessionId: session.providerSessionId,
      checkoutUrl: session.checkoutUrl,
      expiresAt: session.expiresAt,
    },
  };
}

export function createPaymentHttpApi(
  service: PaymentCheckoutService,
  options: PaymentHttpApiOptions,
): PaymentHttpApi {
  const scope = options?.scope;
  if (
    typeof scope !== 'object' ||
    scope === null ||
    typeof scope.organizationId !== 'string' ||
    !IDENTIFIER_PATTERN.test(scope.organizationId)
  ) {
    throw new TypeError('payment HTTP scope is required at composition time.');
  }
  return {
    async handle(request): Promise<PaymentHttpResponse> {
      const parsedRoute = route(request.path);
      if (parsedRoute === undefined) {
        return errorResponse(
          new PaymentHttpError(404, 'route_not_found', 'Payment route was not found.'),
        );
      }
      try {
        if (parsedRoute.kind === 'checkout') {
          if (request.method !== 'POST') {
            throw new PaymentHttpError(
              405,
              'method_not_allowed',
              'Method is not allowed for this route.',
            );
          }
          if (!emptyBody(request.body)) {
            throw new PaymentHttpError(
              400,
              'invalid_input',
              'Checkout amount and identifiers are server-controlled.',
            );
          }
          return checkoutResponse(
            await service.startCheckout(scope, parsedRoute.propertyId, parsedRoute.requestId),
          );
        }
        if (request.method !== 'POST') {
          throw new PaymentHttpError(
            405,
            'method_not_allowed',
            'Method is not allowed for this route.',
          );
        }
        const signature = headerValue(request.headers, 'stripe-signature');
        if (signature === undefined || request.rawBody === undefined) {
          throw Object.assign(new Error('webhook signature is missing'), {
            code: 'invalid_signature',
          });
        }
        await service.handleWebhook(request.rawBody, signature);
        return { status: 200, body: { received: true } };
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
