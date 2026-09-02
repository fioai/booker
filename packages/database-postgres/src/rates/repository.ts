import type { QueryResultRow } from 'pg';

import {
  createRatePlan,
  quoteRatePlan,
  type QuoteBreakdown,
  type RatePlan,
} from '@booking-engine/booking-core';

import { PersistenceError } from '../database/errors.js';
import { lockProperty } from '../database/property-lock.js';
import type { PostgresDatabasePort, PostgresTransactionPort } from '../database/postgres.js';
import { qualifiedTable } from '../database/identifiers.js';

export interface RateOrganizationScope {
  readonly organizationId: string;
}

export interface RateRepository {
  saveRatePlan(scope: RateOrganizationScope, propertyId: string, input: unknown): Promise<RatePlan>;
  getRatePlan(scope: RateOrganizationScope, propertyId: string): Promise<RatePlan | null>;
  quote(scope: RateOrganizationScope, propertyId: string, input: unknown): Promise<QuoteBreakdown>;
}

interface RatePlanRow extends QueryResultRow {
  readonly currency: unknown;
  readonly base_nightly_rate_minor: unknown;
  readonly cleaning_fee_minor: unknown;
  readonly minimum_stay_nights: unknown;
}

interface SeasonalRateRow extends QueryResultRow {
  readonly arrival: unknown;
  readonly departure: unknown;
  readonly nightly_rate_minor: unknown;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_IDENTIFIER_LENGTH = 64;

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
    throw new PersistenceError(code, `${code} must be a valid identifier.`);
  }
}

function validateScope(scope: RateOrganizationScope): string {
  validateIdentifier(scope?.organizationId, 'invalid_organization_id');
  return scope.organizationId;
}

function validatePropertyId(propertyId: string): string {
  validateIdentifier(propertyId, 'invalid_property_id');
  return propertyId;
}

function canonicalizeRatePlan(input: unknown): RatePlan {
  const result = createRatePlan(input);
  if (!result.ok) {
    throw new PersistenceError(
      'rate_validation',
      'rate plan failed domain validation.',
      result.errors,
    );
  }

  return result.value;
}

function parseDatabaseMinorAmount(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PersistenceError('database_corruption', `${field} is not a safe integer amount.`);
  }
  return parsed;
}

function requirePropertyQuery(
  transaction: PostgresTransactionPort,
  propertiesTable: string,
  organizationId: string,
  propertyId: string,
): Promise<void> {
  return transaction
    .query<{
      id: string;
    }>(`SELECT id FROM ${propertiesTable} WHERE organization_id = $1 AND id = $2`, [
      organizationId,
      propertyId,
    ])
    .then((result) => {
      if (result.rowCount === 0) {
        throw new PersistenceError(
          'property_not_found',
          'property does not exist in this organization.',
        );
      }
    });
}

function toRatePlan(planRow: RatePlanRow, overrideRows: readonly SeasonalRateRow[]): RatePlan {
  const input: unknown = {
    currency: planRow.currency,
    baseNightlyRateMinor: parseDatabaseMinorAmount(
      planRow.base_nightly_rate_minor,
      'base_nightly_rate_minor',
    ),
    cleaningFeeMinor: parseDatabaseMinorAmount(planRow.cleaning_fee_minor, 'cleaning_fee_minor'),
    minimumStayNights: planRow.minimum_stay_nights,
    seasonalOverrides: overrideRows.map((row) => ({
      arrival: row.arrival,
      departure: row.departure,
      nightlyRateMinor: parseDatabaseMinorAmount(row.nightly_rate_minor, 'nightly_rate_minor'),
    })),
  };
  return canonicalizeRatePlan(input);
}

export class PostgresRateRepository implements RateRepository {
  private readonly plansTable: string;
  private readonly overridesTable: string;
  private readonly propertiesTable: string;

  constructor(private readonly database: PostgresDatabasePort) {
    this.plansTable = qualifiedTable(database, 'property_rate_plans');
    this.overridesTable = qualifiedTable(database, 'seasonal_rate_overrides');
    this.propertiesTable = qualifiedTable(database, 'properties');
  }

  async saveRatePlan(
    scope: RateOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<RatePlan> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    const plan = canonicalizeRatePlan(input);

    await this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, id);
      await requirePropertyQuery(transaction, this.propertiesTable, organizationId, id);
      await transaction.query(
        `
          INSERT INTO ${this.plansTable} (
            organization_id,
            property_id,
            currency,
            base_nightly_rate_minor,
            cleaning_fee_minor,
            minimum_stay_nights
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (organization_id, property_id) DO UPDATE SET
            currency = EXCLUDED.currency,
            base_nightly_rate_minor = EXCLUDED.base_nightly_rate_minor,
            cleaning_fee_minor = EXCLUDED.cleaning_fee_minor,
            minimum_stay_nights = EXCLUDED.minimum_stay_nights,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
          organizationId,
          id,
          plan.currency,
          plan.baseNightlyRateMinor,
          plan.cleaningFeeMinor,
          plan.minimumStayNights,
        ],
      );
      await transaction.query(
        `DELETE FROM ${this.overridesTable} WHERE organization_id = $1 AND property_id = $2`,
        [organizationId, id],
      );
      for (const [index, override] of plan.seasonalOverrides.entries()) {
        await transaction.query(
          `
            INSERT INTO ${this.overridesTable} (
              organization_id,
              property_id,
              override_id,
              stay,
              nightly_rate_minor
            )
            VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'), $6)
          `,
          [
            organizationId,
            id,
            `override-${index}`,
            override.arrival,
            override.departure,
            override.nightlyRateMinor,
          ],
        );
      }
    });

    return plan;
  }

  async getRatePlan(scope: RateOrganizationScope, propertyId: string): Promise<RatePlan | null> {
    const organizationId = validateScope(scope);
    const id = validatePropertyId(propertyId);
    return this.database.withTransaction(async (transaction) => {
      await lockProperty(transaction, organizationId, id);
      await requirePropertyQuery(transaction, this.propertiesTable, organizationId, id);

      const planResult = await transaction.query<RatePlanRow>(
        `
          SELECT currency, base_nightly_rate_minor, cleaning_fee_minor, minimum_stay_nights
          FROM ${this.plansTable}
          WHERE organization_id = $1 AND property_id = $2
        `,
        [organizationId, id],
      );
      const planRow = planResult.rows[0];
      if (planRow === undefined) {
        return null;
      }
      const overrides = await transaction.query<SeasonalRateRow>(
        `
          SELECT lower(stay)::text AS arrival, upper(stay)::text AS departure, nightly_rate_minor
          FROM ${this.overridesTable}
          WHERE organization_id = $1 AND property_id = $2
          ORDER BY lower(stay)
        `,
        [organizationId, id],
      );
      return toRatePlan(planRow, overrides.rows);
    });
  }

  async quote(
    scope: RateOrganizationScope,
    propertyId: string,
    input: unknown,
  ): Promise<QuoteBreakdown> {
    const plan = await this.getRatePlan(scope, propertyId);
    if (plan === null) {
      throw new PersistenceError(
        'rate_plan_not_found',
        'rate plan does not exist for this property.',
      );
    }
    const result = quoteRatePlan(plan, input);
    if (!result.ok) {
      throw new PersistenceError(
        'rate_validation',
        'quote request failed rate validation.',
        result.errors,
      );
    }
    return result.value;
  }
}

export function createPostgresRateRepository(database: PostgresDatabasePort): RateRepository {
  return new PostgresRateRepository(database);
}
