import type { LotusBookingClientV1 } from '@lotus-booking/sdk-typescript';

/** Admin consumers receive a public-contract client; they do not import engine internals. */
export interface AdminApp {
  readonly client: LotusBookingClientV1;
}

export {
  renderSyncHealthV1,
  SyncHealth,
  type SyncHealthErrorV1,
  type SyncHealthViewV1,
} from './components/sync-health.js';
export {
  renderAdminPropertyPage,
  renderAdminPropertyPageV1,
  type AdminPropertyPageInputV1,
} from './admin-property-page.js';
