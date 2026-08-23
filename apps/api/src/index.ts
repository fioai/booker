import type { BookingCorePort } from '@lotus-booking/booking-core';
import type { CalendarChannel } from '@lotus-booking/channel-calendar';
import type { PostgresDatabasePort } from '@lotus-booking/database-postgres';
import type { NotificationSender } from '@lotus-booking/notifications';
import type { PaymentProvider } from '@lotus-booking/payments';

export interface ApiModuleDependencies {
  readonly bookingCore: BookingCorePort;
  readonly database: PostgresDatabasePort;
  readonly payments: PaymentProvider;
  readonly calendar: CalendarChannel;
  readonly notifications: NotificationSender;
}

export { serializePublicPropertyV1 } from './property-configuration-mapper.js';
export {
  PUBLIC_BOOKING_OPENAPI_PATH_V1,
  PUBLIC_BOOKING_OPENAPI_V1,
  PUBLIC_BOOKING_PATHS_V1,
} from '@lotus-booking/sdk-typescript';
export {
  PublicApiErrorV1,
  PublicBookingApiErrorV1,
  createPublicBookingApiV1,
  createPublicBookingHttpApiV1,
  serializePublicAvailabilityV1,
  serializePublicBookingRequestV1,
  serializePublicPropertyResponseV1,
  serializePublicQuoteV1,
  type PublicBookingApiDependenciesV1,
  type PublicBookingApiV1,
  type PublicBookingHttpApiV1,
  type PublicBookingRequestRepositoryV1,
  type PublicBookingScopeV1,
  type PublicHttpRequestV1,
  type PublicHttpResponseV1,
} from './public-booking-api.js';
export {
  createPublicBookingHttpServerV1,
  type PublicBookingHttpServerAddressV1,
  type PublicBookingHttpServerOptionsV1,
  type PublicBookingHttpServerV1,
} from './public-booking-http-server.js';
export {
  createPaymentHttpApiV1,
  type PaymentHttpApiOptionsV1,
  type PaymentHttpApiV1,
  type PaymentHttpRequestV1,
  type PaymentHttpResponseV1,
} from './payment-http-api.js';
export {
  createAdminHttpServerV1,
  type AdminHttpServerAddressV1,
  type AdminHttpServerOptionsV1,
  type AdminHttpServerV1,
} from './admin-http-server.js';
export {
  ADMIN_CSRF_COOKIE_V1,
  ADMIN_SESSION_COOKIE_V1,
  AdminHttpErrorV1,
  createAdminHttpApiV1,
  type AdminCredentialRecordV1,
  type AdminHttpApiDependenciesV1,
  type AdminHttpApiOptionsV1,
  type AdminHttpApiV1,
  type AdminHttpRequestV1,
  type AdminHttpResponseV1,
  type AdminICalHealthPortV1,
  type AdminPagePropertyV1,
  type AdminRoleV1,
} from './admin-api.js';
export {
  ADMIN_PASSWORD_MAX_LENGTH_V1,
  ADMIN_PASSWORD_MIN_LENGTH_V1,
  ADMIN_SESSION_TTL_MS_V1,
  authenticateOwnerV1,
  createAdminSessionStoreV1,
  hashOwnerPasswordV1,
  normalizeAdminEmailV1,
  verifyOwnerPasswordV1,
  validateAdminSessionStoreOptionsV1,
  validateAdminSessionUserV1,
  type AdminCredentialStoreV1,
  type AdminInMemorySessionStoreV1,
  type AdminSessionStoreOptionsV1,
  type AdminSessionStoreV1,
  type AdminSessionTicketV1,
  type AdminSessionUserV1,
  type AdminSessionV1,
} from './admin-auth.js';
export {
  createPostgresAdminCredentialStoreV1,
  createPostgresAdminSessionStoreV1,
  type PostgresAdminCredentialStoreV1,
  type PostgresAdminSessionStoreV1,
} from './admin-postgres-auth.js';
export {
  ICalCommitAvailabilityError,
  createICalSyncJob,
  recheckAvailabilityBeforeApproval,
  recheckAvailabilityBeforeCommit,
  recheckAvailabilityBeforePayment,
  type AvailabilityRecheckPort,
  type ICalClock,
  type ICalStay,
  type ICalSyncConfig,
  type ICalSyncError,
  type ICalSyncHealth,
  type ICalSyncJobDependencies,
  type ICalSyncRunResult,
} from './jobs/ical-sync.js';
