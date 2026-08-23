import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@lotus-booking/booking-core': fileURLToPath(
        new URL('./packages/booking-core/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/sdk-typescript': fileURLToPath(
        new URL('./packages/sdk-typescript/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/channel-ical': fileURLToPath(
        new URL('./packages/channel-ical/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/database-postgres': fileURLToPath(
        new URL('./packages/database-postgres/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/channel-calendar': fileURLToPath(
        new URL('./packages/channel-calendar/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/payments': fileURLToPath(
        new URL('./packages/payments/src/index.ts', import.meta.url),
      ),
      '@lotus-booking/payments-stripe': fileURLToPath(
        new URL('./packages/payments-stripe/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
