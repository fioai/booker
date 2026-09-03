import type {
  AvailabilityRecord,
  AvailabilityRepository,
  BookingRequestRecord,
  BookingRequestRepository,
  OrganizationScope,
  PropertyRepository,
  RateRepository,
} from '@booking-engine/database-postgres';
import type { ICalScope } from '@booking-engine/channel-ical';
import type {
  PropertyConfiguration,
  PropertyConfigurationInput,
  QuoteBreakdown,
  RatePlan,
} from '@booking-engine/booking-core';
import type {
  AdminCredentialRecord,
  AdminCredentialStore,
  AdminRole,
  AdminSession,
  AdminSessionStore,
  AdminSessionStoreOptions,
  AdminSessionUser,
} from './auth.js';
import type { ICalSyncHealth, ICalSyncRunResult } from '../jobs/ical/sync.js';

export interface AdminICalHealthPort {
  health(scope: ICalScope, sourceId: string): ICalSyncHealth | Promise<ICalSyncHealth>;
}

export interface AdminHttpApiDependencies {
  readonly credentials: AdminCredentialStore;
  readonly properties: Pick<PropertyRepository, 'findById' | 'update'>;
  readonly rates: Pick<RateRepository, 'getRatePlan' | 'saveRatePlan'>;
  readonly availability: Pick<
    AvailabilityRepository,
    'listManualBlocks' | 'createManualBlock' | 'releaseManualBlock'
  >;
  readonly bookingRequests: Pick<
    BookingRequestRepository,
    'find' | 'approve' | 'reject' | 'recheckAvailability'
  > & {
    readonly list?: (
      scope: OrganizationScope,
      propertyId: string,
    ) => Promise<readonly BookingRequestRecord[]>;
  };
  readonly ical: AdminICalHealthPort;
}

export interface AdminPageProperty {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export interface AdminHttpApiOptions {
  readonly secureCookies?: boolean;
  readonly sessionStore?: AdminSessionStore;
  readonly session?: AdminSessionStoreOptions;
  /** Optional exact origin for deployments behind a known local reverse proxy. */
  readonly origin?: string;
  readonly renderPropertyPage?: (input: {
    readonly property: AdminPageProperty;
    readonly csrfToken: string;
  }) => string;
}

export interface AdminHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface AdminHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
}

export interface AdminHttpApi {
  handle(request: AdminHttpRequest): Promise<AdminHttpResponse>;
}

export class AdminHttpError extends Error {
  readonly status: number;
  readonly code:
    | 'invalid_credentials'
    | 'invalid_session'
    | 'csrf_invalid'
    | 'forbidden'
    | 'not_found'
    | 'validation_failed'
    | 'conflict'
    | 'method_not_allowed'
    | 'route_not_found'
    | 'internal_error';
  readonly details: readonly { readonly field: string; readonly message: string }[] | undefined;

  constructor(
    status: number,
    code: AdminHttpError['code'],
    message: string,
    details?: readonly { readonly field: string; readonly message: string }[],
  ) {
    super(message);
    this.name = 'AdminHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response(): { readonly error: Record<string, unknown> } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export interface AdminPropertyResponse extends AdminPageProperty {
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: PropertyConfiguration['propertyType'];
  readonly bedroomCount: number;
  readonly bedConfiguration: PropertyConfiguration['bedConfiguration'];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
}

export interface AdminRatePlanResponse {
  readonly currency: string;
  readonly baseNightlyRateMinor: number;
  readonly cleaningFeeMinor: number;
  readonly minimumStayNights: number;
  readonly seasonalOverrides: readonly {
    readonly arrival: string;
    readonly departure: string;
    readonly nightlyRateMinor: number;
  }[];
}

export interface AdminManualBlockResponse {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: 'manual';
  readonly status: AvailabilityRecord['status'];
  readonly arrival: string;
  readonly departure: string;
  readonly expiresAt: string | null;
  readonly reason: string | null;
}

export interface AdminUserResponse {
  readonly id: string;
  readonly email: string;
  readonly role: AdminRole;
}

export type { AdminCredentialRecord, AdminRole, ICalSyncHealth, ICalSyncRunResult };
export type {
  AvailabilityRecord,
  BookingRequestRecord,
  OrganizationScope,
  PropertyConfiguration,
  PropertyConfigurationInput,
  QuoteBreakdown,
  RatePlan,
  AdminSession,
  AdminSessionUser,
};
