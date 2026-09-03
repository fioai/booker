/* global process */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresDatabase } from '../packages/database-postgres/dist/index.js';

import { validateRuntimeEnvironment } from './lib/environment.mjs';

export const SAMPLE_DATA = Object.freeze({
  organization: Object.freeze({
    id: 'sample-tenant',
    name: 'Booking Engine local sample tenant',
  }),
  property: Object.freeze({
    id: 'sample-bungalow',
    name: 'Sample Garden Bungalow',
    summary: 'A one-bedroom bungalow with a private garden for short stays.',
    country: 'CA',
    timezone: 'America/Toronto',
    currency: 'CAD',
    propertyType: 'bungalow',
    bedroomCount: 1,
    bedConfiguration: Object.freeze([{ type: 'double', quantity: 1 }]),
    bathroomCount: 1,
    maximumGuests: 2,
    amenities: Object.freeze([
      'private garden',
      'fibre Wi-Fi',
      'air conditioning',
      'Smart TV',
      'free street parking',
    ]),
    hostNotes: 'A quiet sample property for local verification.',
    operationalNotes: 'PRIVATE SAMPLE MARKER: confirm the guest key is returned on checkout.',
  }),
  rate: Object.freeze({
    currency: 'CAD',
    baseNightlyRateMinor: 12_500,
    cleaningFeeMinor: 0,
    minimumStayNights: 2,
  }),
  owner: Object.freeze({
    id: 'sample-owner',
    email: 'sample-owner@example.test',
    role: 'owner',
  }),
});

function table(schema, name) {
  return '"' + schema.replaceAll('"', '""') + '"."' + name + '"';
}

export async function seedSampleData(database, passwordHash) {
  if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
    throw new TypeError('sample seed requires a password hash.');
  }
  const schema = database.schema;
  const organizations = table(schema, 'organizations');
  const properties = table(schema, 'properties');
  const plans = table(schema, 'property_rate_plans');
  const identities = table(schema, 'owner_identities');
  const memberships = table(schema, 'organization_memberships');
  const sample = SAMPLE_DATA;
  await database.withTransaction(async (transaction) => {
    await transaction.query(
      [
        'INSERT INTO ' + organizations + ' (id, name)',
        'VALUES ($1, $2)',
        'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
      ].join('\n'),
      [sample.organization.id, sample.organization.name],
    );
    await transaction.query(
      [
        'INSERT INTO ' + properties + ' (',
        '  organization_id, id, name, summary, country, timezone, currency, property_type,',
        '  bedroom_count, bed_configuration, bathroom_count, maximum_guests, amenities,',
        '  host_notes, operational_notes',
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15)',
        'ON CONFLICT (organization_id, id) DO UPDATE SET',
        '  name = EXCLUDED.name, summary = EXCLUDED.summary, country = EXCLUDED.country,',
        '  timezone = EXCLUDED.timezone, currency = EXCLUDED.currency,',
        '  property_type = EXCLUDED.property_type, bedroom_count = EXCLUDED.bedroom_count,',
        '  bed_configuration = EXCLUDED.bed_configuration, bathroom_count = EXCLUDED.bathroom_count,',
        '  maximum_guests = EXCLUDED.maximum_guests, amenities = EXCLUDED.amenities,',
        '  host_notes = EXCLUDED.host_notes, operational_notes = EXCLUDED.operational_notes,',
        '  updated_at = CURRENT_TIMESTAMP',
      ].join('\n'),
      [
        sample.organization.id,
        sample.property.id,
        sample.property.name,
        sample.property.summary,
        sample.property.country,
        sample.property.timezone,
        sample.property.currency,
        sample.property.propertyType,
        sample.property.bedroomCount,
        JSON.stringify(sample.property.bedConfiguration),
        sample.property.bathroomCount,
        sample.property.maximumGuests,
        JSON.stringify(sample.property.amenities),
        sample.property.hostNotes,
        sample.property.operationalNotes,
      ],
    );
    await transaction.query(
      [
        'INSERT INTO ' +
          plans +
          ' (organization_id, property_id, currency, base_nightly_rate_minor, cleaning_fee_minor, minimum_stay_nights)',
        'VALUES ($1, $2, $3, $4, $5, $6)',
        'ON CONFLICT (organization_id, property_id) DO UPDATE SET',
        '  currency = EXCLUDED.currency, base_nightly_rate_minor = EXCLUDED.base_nightly_rate_minor,',
        '  cleaning_fee_minor = EXCLUDED.cleaning_fee_minor, minimum_stay_nights = EXCLUDED.minimum_stay_nights,',
        '  updated_at = CURRENT_TIMESTAMP',
      ].join('\n'),
      [
        sample.organization.id,
        sample.property.id,
        sample.rate.currency,
        sample.rate.baseNightlyRateMinor,
        sample.rate.cleaningFeeMinor,
        sample.rate.minimumStayNights,
      ],
    );
    await transaction.query(
      [
        'INSERT INTO ' + identities + ' (id, email, password_hash)',
        'VALUES ($1, $2, $3)',
        'ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, disabled_at = NULL',
      ].join('\n'),
      [sample.owner.id, sample.owner.email, passwordHash],
    );
    await transaction.query(
      [
        'INSERT INTO ' + memberships + ' (identity_id, organization_id, role, status)',
        "VALUES ($1, $2, $3, 'active')",
        'ON CONFLICT (identity_id, organization_id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status',
      ].join('\n'),
      [sample.owner.id, sample.organization.id, sample.owner.role],
    );
  });
}

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/seed-sample.mjs',
      '',
      'Requires BOOKING_ENGINE_ENV=local|test, BOOKING_ENGINE_SAMPLE_DATA=true, and BOOKING_ENGINE_SAMPLE_PASSWORD.',
      'The seed is deterministic, idempotent, and never drops tables or rows.',
    ].join('\n') + '\n',
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const config = validateRuntimeEnvironment(process.env);
  if (
    !config.sampleData ||
    config.organizationId !== SAMPLE_DATA.organization.id ||
    config.propertyId !== SAMPLE_DATA.property.id
  ) {
    throw new Error(
      'sample seed requires the documented local sample identifiers and BOOKING_ENGINE_SAMPLE_DATA=true.',
    );
  }
  const { hashOwnerPassword } = await import('../apps/api/dist/index.js');
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    schema: config.schema,
  });
  try {
    const passwordHash = await hashOwnerPassword(config.samplePassword);
    await seedSampleData(database, passwordHash);
  } finally {
    await database.close();
  }
  process.stdout.write(
    'Deterministic local sample data is ready (tenant and property identifiers only).\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'sample seed failed';
    process.stderr.write('Sample seed failed: ' + message + '\n');
    process.exitCode = 1;
  });
}
