import type {
  AvailabilityRepository,
  BookingRequestRepository,
  OrganizationScope,
  PropertyRepository,
  RateRepository,
} from '@booking-engine/database-postgres';
import type {
  PublicApiErrorCodeV1,
  PublicApiErrorResponseV1,
  PublicAvailabilityV1,
  PublicPropertyV1,
  PublicQuoteV1,
  PublicRequestToBookV1,
  PublicValidationIssueV1,
} from '@booking-engine/sdk-typescript';

export type PublicBookingScope = OrganizationScope;

export type PublicBookingRequestRepository = Pick<
  BookingRequestRepository,
  'findByIdempotencyKey' | 'submit'
>;

export interface PublicBookingApiDependencies {
  readonly properties: Pick<PropertyRepository, 'findPublicById'>;
  readonly availability: Pick<AvailabilityRepository, 'isAvailable'>;
  readonly rates: Pick<RateRepository, 'quote'>;
  readonly bookingRequests: PublicBookingRequestRepository;
}

export interface PublicHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface PublicHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export class PublicBookingApiError extends Error {
  readonly status: number;
  readonly code: PublicApiErrorCodeV1;
  readonly details: readonly PublicValidationIssueV1[] | undefined;

  constructor(
    status: number,
    code: PublicApiErrorCodeV1,
    message: string,
    details?: readonly PublicValidationIssueV1[],
  ) {
    super(message);
    this.name = 'PublicBookingApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response(): PublicApiErrorResponseV1 {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const PublicApiErrorV1 = PublicBookingApiError;

export interface PublicBookingApi {
  getProperty(scope: PublicBookingScope, propertyId: string): Promise<PublicPropertyV1>;
  getAvailability(
    scope: PublicBookingScope,
    propertyId: string,
    input: unknown,
  ): Promise<PublicAvailabilityV1>;
  getQuote(scope: PublicBookingScope, propertyId: string, input: unknown): Promise<PublicQuoteV1>;
  requestToBook(
    scope: PublicBookingScope,
    propertyId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<PublicRequestToBookV1>;
}

export interface PublicBookingHttpApi {
  handle(scope: PublicBookingScope, request: PublicHttpRequest): Promise<PublicHttpResponse>;
}
