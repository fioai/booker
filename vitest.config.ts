import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@booking-engine/booking-core': fileURLToPath(
        new URL('./packages/booking-core/src/index.ts', import.meta.url),
      ),
      '@booking-engine/sdk-typescript': fileURLToPath(
        new URL('./packages/sdk-typescript/src/index.ts', import.meta.url),
      ),
      '@booking-engine/channel-ical': fileURLToPath(
        new URL('./packages/channel-ical/src/index.ts', import.meta.url),
      ),
      '@booking-engine/database-postgres': fileURLToPath(
        new URL('./packages/database-postgres/src/index.ts', import.meta.url),
      ),
      '@booking-engine/channel-calendar': fileURLToPath(
        new URL('./packages/channel-calendar/src/index.ts', import.meta.url),
      ),
      '@booking-engine/payments': fileURLToPath(
        new URL('./packages/payments/src/index.ts', import.meta.url),
      ),
      '@booking-engine/payments-stripe': fileURLToPath(
        new URL('./packages/payments-stripe/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
