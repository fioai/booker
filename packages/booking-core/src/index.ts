export * from './property-configuration.js';
export * from './property-configuration-limits.js';
export type * from './property-configuration-types.js';
export * from './availability-rates.js';
export * from './request-lifecycle.js';

/** Domain ownership boundary. */
export interface BookingCorePort {
  readonly packageName: '@lotus-booking/booking-core';
}
