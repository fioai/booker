import type { QueryResultRow } from 'pg';

import {
  createPropertyConfiguration,
  type PropertyValidationError,
  type PropertyConfiguration,
} from '@booking-engine/booking-core';
import { PersistenceError, isPostgresError } from '../database/errors.js';

import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_IDENTIFIER_LENGTH = 64;

export interface OrganizationScope {
  readonly organizationId: string;
}

export interface PropertyRepository {
  create(scope: OrganizationScope, input: unknown): Promise<PropertyConfiguration>;
  findById(scope: OrganizationScope, propertyId: string): Promise<PropertyConfiguration | null>;
  list(scope: OrganizationScope): Promise<readonly PropertyConfiguration[]>;
  update(
    scope: OrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<PropertyConfiguration | null>;
  delete(scope: OrganizationScope, propertyId: string): Promise<boolean>;
  findPublicById(
    scope: OrganizationScope,
    propertyId: string,
  ): Promise<PropertyConfiguration | null>;
  /** Returns the canonical private projection; only the API mapper may serialize it externally. */
  listPublic(scope: OrganizationScope): Promise<readonly PropertyConfiguration[]>;
}

interface StoredPropertyRow extends QueryResultRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly summary: unknown;
  readonly country: unknown;
  readonly timezone: unknown;
  readonly currency: unknown;
  readonly property_type: unknown;
  readonly bedroom_count: unknown;
  readonly bed_configuration: unknown;
  readonly bathroom_count: unknown;
  readonly maximum_guests: unknown;
  readonly amenities: unknown;
  readonly host_notes: unknown;
  readonly operational_notes: unknown;
}

interface PublicPropertyRow extends QueryResultRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly summary: unknown;
  readonly country: unknown;
  readonly timezone: unknown;
  readonly currency: unknown;
  readonly property_type: unknown;
  readonly bedroom_count: unknown;
  readonly bed_configuration: unknown;
  readonly bathroom_count: unknown;
  readonly maximum_guests: unknown;
  readonly amenities: unknown;
  readonly host_notes: unknown;
}

function validateIdentifier(
  value: unknown,
  code: 'invalid_organization_id' | 'invalid_property_id',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PersistenceError(
      code,
      `${code === 'invalid_organization_id' ? 'organization id' : 'property id'} must be a non-empty identifier of at most 64 characters.`,
    );
  }
}

function validateScope(scope: OrganizationScope): string {
  validateIdentifier(scope?.organizationId, 'invalid_organization_id');
  return scope.organizationId;
}

function validatePropertyId(propertyId: string): string {
  validateIdentifier(propertyId, 'invalid_property_id');
  return propertyId;
}

function canonicalizeProperty(input: unknown): PropertyConfiguration {
  const result = createPropertyConfiguration(input);
  if (!result.ok) {
    throw new PersistenceError(
      'property_validation',
      'property configuration failed domain validation.',
      result.errors,
    );
  }

  return result.value;
}

function assertMatchingPropertyId(property: PropertyConfiguration, propertyId: string): void {
  if (property.id !== propertyId) {
    throw new PersistenceError(
      'invalid_property_id',
      'property input id must match the property id being updated.',
    );
  }
}

function propertyValues(
  organizationId: string,
  property: PropertyConfiguration,
): readonly unknown[] {
  return [
    organizationId,
    property.id,
    property.name,
    property.summary,
    property.country,
    property.timezone,
    property.currency,
    property.propertyType,
    property.bedroomCount,
    JSON.stringify(property.bedConfiguration),
    property.bathroomCount,
    property.maximumGuests,
    JSON.stringify(property.amenities),
    property.hostNotes,
    property.operationalNotes,
  ];
}

function toDomainInput(row: StoredPropertyRow): unknown {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    country: row.country,
    timezone: row.timezone,
    currency: row.currency,
    propertyType: row.property_type,
    bedroomCount: row.bedroom_count,
    bedConfiguration: row.bed_configuration,
    bathroomCount: row.bathroom_count,
    maximumGuests: row.maximum_guests,
    amenities: row.amenities,
    hostNotes: row.host_notes,
    operationalNotes: row.operational_notes,
  };
}

function fromStoredRow(row: StoredPropertyRow): PropertyConfiguration {
  return canonicalizeProperty(toDomainInput(row));
}

function databaseCorruption(
  message: string,
  errors?: readonly PropertyValidationError[],
): PersistenceError {
  return new PersistenceError('database_corruption', message, errors);
}

function fromPublicRow(row: PublicPropertyRow): PropertyConfiguration {
  const result = createPropertyConfiguration({
    id: row.id,
    name: row.name,
    summary: row.summary,
    country: row.country,
    timezone: row.timezone,
    currency: row.currency,
    propertyType: row.property_type,
    bedroomCount: row.bedroom_count,
    bedConfiguration: row.bed_configuration,
    bathroomCount: row.bathroom_count,
    maximumGuests: row.maximum_guests,
    amenities: row.amenities,
    hostNotes: row.host_notes,
    operationalNotes: 'public projection validation sentinel',
  });
  if (!result.ok) {
    throw databaseCorruption('public property row failed domain validation.', result.errors);
  }

  return result.value;
}

export class PostgresPropertyRepository implements PropertyRepository {
  private readonly propertiesTable: string;
  private readonly publicPropertiesTable: string;
  private readonly organizationsTable: string;

  constructor(private readonly database: PostgresDatabasePort) {
    this.propertiesTable = qualifiedTable(database, 'properties');
    this.publicPropertiesTable = qualifiedTable(database, 'public_properties');
    this.organizationsTable = qualifiedTable(database, 'organizations');
  }

  private async requireOrganization(organizationId: string): Promise<void> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM ${this.organizationsTable} WHERE id = $1`,
      [organizationId],
    );
    if (result.rowCount === 0) {
      throw new PersistenceError('organization_not_found', 'organization does not exist.');
    }
  }

  async create(scope: OrganizationScope, input: unknown): Promise<PropertyConfiguration> {
    const organizationId = validateScope(scope);
    const property = canonicalizeProperty(input);
    await this.requireOrganization(organizationId);

    try {
      await this.database.query(
        `
          INSERT INTO ${this.propertiesTable} (
            organization_id,
            id,
            name,
            summary,
            country,
            timezone,
            currency,
            property_type,
            bedroom_count,
            bed_configuration,
            bathroom_count,
            maximum_guests,
            amenities,
            host_notes,
            operational_notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15)
        `,
        propertyValues(organizationId, property),
      );
      return property;
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') {
        throw new PersistenceError(
          'duplicate_property',
          'property already exists in this organization.',
        );
      }
      throw error;
    }
  }

  async findById(
    scope: OrganizationScope,
    propertyId: string,
  ): Promise<PropertyConfiguration | null> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    const result = await this.database.query<StoredPropertyRow>(
      `
        SELECT id, name, summary, country, timezone, currency, property_type,
               bedroom_count, bed_configuration, bathroom_count, maximum_guests,
               amenities, host_notes, operational_notes
        FROM ${this.propertiesTable}
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, id],
    );
    const row = result.rows[0];
    return row === undefined ? null : fromStoredRow(row);
  }

  async list(scope: OrganizationScope): Promise<readonly PropertyConfiguration[]> {
    const organizationId = validateScope(scope);
    const result = await this.database.query<StoredPropertyRow>(
      `
        SELECT id, name, summary, country, timezone, currency, property_type,
               bedroom_count, bed_configuration, bathroom_count, maximum_guests,
               amenities, host_notes, operational_notes
        FROM ${this.propertiesTable}
        WHERE organization_id = $1
        ORDER BY id
      `,
      [organizationId],
    );
    return Object.freeze(result.rows.map(fromStoredRow));
  }

  async update(
    scope: OrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<PropertyConfiguration | null> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    const property = canonicalizeProperty(input);
    assertMatchingPropertyId(property, id);

    const result = await this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, id);
      return transaction.query<StoredPropertyRow>(
        `
          UPDATE ${this.propertiesTable}
          SET name = $3,
              summary = $4,
              country = $5,
              timezone = $6,
              currency = $7,
              property_type = $8,
              bedroom_count = $9,
              bed_configuration = $10::jsonb,
              bathroom_count = $11,
              maximum_guests = $12,
              amenities = $13::jsonb,
              host_notes = $14,
              operational_notes = $15,
              updated_at = CURRENT_TIMESTAMP
          WHERE organization_id = $1 AND id = $2
          RETURNING id, name, summary, country, timezone, currency, property_type,
                    bedroom_count, bed_configuration, bathroom_count, maximum_guests,
                    amenities, host_notes, operational_notes
        `,
        propertyValues(organizationId, property),
      );
    });
    const row = result.rows[0];
    return row === undefined ? null : fromStoredRow(row);
  }

  async delete(scope: OrganizationScope, propertyId: string): Promise<boolean> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    const result = await this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, id);
      return transaction.query(
        `DELETE FROM ${this.propertiesTable} WHERE organization_id = $1 AND id = $2`,
        [organizationId, id],
      );
    });
    return result.rowCount === 1;
  }

  async findPublicById(
    scope: OrganizationScope,
    propertyId: string,
  ): Promise<PropertyConfiguration | null> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    const result = await this.database.query<PublicPropertyRow>(
      `
        SELECT id, name, summary, country, timezone, currency, property_type,
               bedroom_count, bed_configuration, bathroom_count, maximum_guests,
               amenities, host_notes
        FROM ${this.publicPropertiesTable}
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, id],
    );
    const row = result.rows[0];
    return row === undefined ? null : fromPublicRow(row);
  }

  async listPublic(scope: OrganizationScope): Promise<readonly PropertyConfiguration[]> {
    const organizationId = validateScope(scope);
    const result = await this.database.query<PublicPropertyRow>(
      `
        SELECT id, name, summary, country, timezone, currency, property_type,
               bedroom_count, bed_configuration, bathroom_count, maximum_guests,
               amenities, host_notes
        FROM ${this.publicPropertiesTable}
        WHERE organization_id = $1
        ORDER BY id
      `,
      [organizationId],
    );
    return Object.freeze(result.rows.map(fromPublicRow));
  }
}

export function createPostgresPropertyRepository(
  database: PostgresDatabasePort,
): PropertyRepository {
  return new PostgresPropertyRepository(database);
}
