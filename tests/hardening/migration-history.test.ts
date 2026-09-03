import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATION_FILES } from '../../packages/database-postgres/src/database/migrations.js';

const migrationDirectory = resolve(
  import.meta.dirname,
  '../../packages/database-postgres/migrations',
);
const migrationFilesOnDisk = readdirSync(migrationDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const HISTORICAL_MIGRATION_HASHES = {
  '001_organizations_properties.sql':
    '9de745a3efd9b0efacd752178151e08abf894e546519a1af7e9ba4a9a71b9bf0',
  '002_availability_rates.sql': 'b6e29d1daaf8be61602819344eb648613efa5ae7101f1bc495d7d7d5c4945174',
  '003_booking_requests.sql': '93e336958c53f2c3db08ae45ee6d5b6c19e1fef908c3953ffe1aced1a47df8d4',
  '004_ical_blocks.sql': 'cf97fdb658056e98316c51c7efb5470a7f422591938769875b5e8c40e4fc96f2',
  '005_request_lifecycle.sql': 'd1b75d08179210c8b3ff92305b575a965f3fa1acef546ba02f7aeaf06be4a538',
  '006_owner_auth.sql': 'a715130530286cc4d710449ace776c9b35b2a65502416d7b63e346b1f71a8371',
  '007_admin_sessions.sql': '837074683834366e3b70081a21f04fd5bf6ec7e3a68fd280d72a76f235579365',
  '008_payments.sql': '4a981bb12fa467226c38fb2a1d49a05a9f6b3b2e52e3c4e7e863749d69591ac5',
  '009_public_pending_requests.sql':
    '0f370824812298895e09beb2d1f7e16e68f05d11d5af2b59090b4c5d8e886bce',
  '010_request_lifecycle_legacy_repair.sql':
    '4b85bd2715868a855a85653c33932818c4d461a8d295c50c74b802d9b275224e',
  '011_ical_sequence_bound.sql': 'a4cfb8f873b79f9497e8ff0720ed15762ecf9d42d22734e4a8fee9476127137a',
  '012_request_hold_stay_repair.sql':
    '9edeca83ec512db42bcf03a54b02c35ccc57bb7e2c86daaea8d6d68cfe62030a',
} as const;

describe('historical migration integrity', () => {
  it('keeps the migration directory, configured manifest, and pinned hashes in exact order', () => {
    expect(MIGRATION_FILES).toEqual(migrationFilesOnDisk);
    expect(Object.keys(HISTORICAL_MIGRATION_HASHES)).toEqual(migrationFilesOnDisk);
  });

  it.each(Object.entries(HISTORICAL_MIGRATION_HASHES))(
    '%s matches the applied SHA-256',
    (fileName, expectedHash) => {
      const contents = readFileSync(resolve(migrationDirectory, fileName));
      const actualHash = createHash('sha256').update(contents).digest('hex');

      expect(actualHash).toBe(expectedHash);
    },
  );
});
