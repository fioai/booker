import type { BookingEngineClientV1 } from '@booking-engine/sdk-typescript';

/** Admin consumers receive a public-contract client; they do not import engine internals. */
export interface AdminApp {
  readonly client: BookingEngineClientV1;
}

export {
  renderSyncHealth,
  SyncHealth,
  type SyncHealthError,
  type SyncHealthView,
} from './components/sync-health.js';
export { renderAdminPropertyPage, type AdminPropertyPageInput } from './admin-property-page.js';
