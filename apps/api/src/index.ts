import type { BookingCorePort } from '@booking-engine/booking-core';
import type { CalendarChannel } from '@booking-engine/channel-calendar';
import type { PostgresDatabasePort } from '@booking-engine/database-postgres';
import type { NotificationSender } from '@booking-engine/notifications';
import type { PaymentProvider } from '@booking-engine/payments';

export interface ApiModuleDependencies {
  readonly bookingCore: BookingCorePort;
  readonly database: PostgresDatabasePort;
  readonly payments: PaymentProvider;
  readonly calendar: CalendarChannel;
  readonly notifications: NotificationSender;
}

export { serializePublicProperty } from './property/configuration/mapper.js';
export {
  PUBLIC_BOOKING_OPENAPI_PATH_V1,
  PUBLIC_BOOKING_OPENAPI_V1,
  PUBLIC_BOOKING_PATHS_V1,
} from '@booking-engine/sdk-typescript';
export {
  PublicApiErrorV1,
  PublicBookingApiError,
  createPublicBookingApi,
  createPublicBookingHttpApi,
  serializePublicAvailability,
  serializePublicBookingRequest,
  serializePublicPropertyResponse,
  serializePublicQuote,
  type PublicBookingApiDependencies,
  type PublicBookingApi,
  type PublicBookingHttpApi,
  type PublicBookingRequestRepository,
  type PublicBookingScope,
  type PublicHttpRequest,
  type PublicHttpResponse,
} from './public/booking/api.js';
export {
  createPublicBookingHttpServer,
  type PublicBookingHttpServerAddress,
  type PublicBookingHttpServerOptions,
  type PublicBookingHttpServer,
} from './public/booking/http-server.js';
export {
  createPaymentHttpApi,
  type PaymentHttpApiOptions,
  type PaymentHttpApi,
  type PaymentHttpRequest,
  type PaymentHttpResponse,
} from './payment/http/api.js';
export {
  createAdminHttpServer,
  type AdminHttpServerAddress,
  type AdminHttpServerOptions,
  type AdminHttpServer,
} from './admin/http-server.js';
export {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  AdminHttpError,
  createAdminHttpApi,
  type AdminCredentialRecord,
  type AdminHttpApiDependencies,
  type AdminHttpApiOptions,
  type AdminHttpApi,
  type AdminHttpRequest,
  type AdminHttpResponse,
  type AdminICalHealthPort,
  type AdminPageProperty,
  type AdminRole,
} from './admin/api.js';
export {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_SESSION_TTL_MS,
  authenticateOwner,
  createAdminSessionStore,
  hashOwnerPassword,
  normalizeAdminEmail,
  verifyOwnerPassword,
  validateAdminSessionStoreOptions,
  validateAdminSessionUser,
  type AdminCredentialStore,
  type AdminInMemorySessionStore,
  type AdminSessionStoreOptions,
  type AdminSessionStore,
  type AdminSessionTicket,
  type AdminSessionUser,
  type AdminSession,
} from './admin/auth.js';
export {
  createPostgresAdminCredentialStore,
  createPostgresAdminSessionStore,
  type PostgresAdminCredentialStore,
  type PostgresAdminSessionStore,
} from './admin/postgres-auth.js';
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
} from './jobs/ical/sync.js';
