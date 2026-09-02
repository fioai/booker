import {
  createLocalDateInterval,
  createPropertyConfiguration,
  createRatePlan,
  type PropertyConfiguration,
  type PropertyConfigurationInput,
  type RatePlan,
} from '@booking-engine/booking-core';

import { SAFE_IDENTIFIER } from './routes.js';
import { hasControlCharacters, requireAllowedKeys } from './security.js';
import { validationError } from './serialization.js';

export function validIdentifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    validationError([{ field, code: 'malformed_id' }]);
  }
  return value;
}

export function propertyInput(property: PropertyConfiguration): PropertyConfigurationInput {
  return {
    id: property.id,
    name: property.name,
    summary: property.summary,
    country: property.country,
    timezone: property.timezone,
    currency: property.currency,
    propertyType: property.propertyType,
    bedroomCount: property.bedroomCount,
    bedConfiguration: property.bedConfiguration.map((bed) => ({
      type: bed.type,
      quantity: bed.quantity,
    })),
    bathroomCount: property.bathroomCount,
    maximumGuests: property.maximumGuests,
    amenities: [...property.amenities],
    hostNotes: property.hostNotes,
    operationalNotes: property.operationalNotes,
  };
}

export function canonicalProperty(property: PropertyConfiguration): PropertyConfiguration {
  const result = createPropertyConfiguration(propertyInput(property));
  if (!result.ok) {
    throw new Error('property repository returned invalid configuration.');
  }
  return result.value;
}

export const PROPERTY_FIELDS = new Set([
  'id',
  'name',
  'summary',
  'country',
  'timezone',
  'currency',
  'propertyType',
  'bedroomCount',
  'bedConfiguration',
  'bathroomCount',
  'maximumGuests',
  'amenities',
  'hostNotes',
  'operationalNotes',
]);
export const CONTENT_FIELDS = new Set(['name', 'summary', 'hostNotes', 'operationalNotes']);
export const RATE_FIELDS = new Set([
  'currency',
  'baseNightlyRateMinor',
  'cleaningFeeMinor',
  'minimumStayNights',
  'seasonalOverrides',
]);
export const RATE_OVERRIDE_FIELDS = new Set(['arrival', 'departure', 'nightlyRateMinor']);
export const MANUAL_BLOCK_FIELDS = new Set(['id', 'arrival', 'departure', 'reason']);

export function propertyUpdateInput(
  property: PropertyConfiguration,
  body: Record<string, unknown>,
): PropertyConfigurationInput {
  const keys = Object.keys(body);
  if (keys.length === 0) {
    validationError([{ field: 'body', code: 'invalid_input' }]);
  }
  const isContentUpdate = keys.every((key) => CONTENT_FIELDS.has(key));
  const isFullUpdate = keys.every((key) => PROPERTY_FIELDS.has(key));
  if (!isContentUpdate && !isFullUpdate) {
    requireAllowedKeys(body, PROPERTY_FIELDS);
    validationError([{ field: 'body', code: 'invalid_input' }]);
  }
  const input: Record<string, unknown> = isContentUpdate
    ? { ...propertyInput(property) }
    : { ...body };
  if (isContentUpdate) {
    for (const field of keys) {
      input[field] = body[field] as never;
    }
  }
  requireAllowedKeys(input, PROPERTY_FIELDS);
  return input as unknown as PropertyConfigurationInput;
}

export function validatePropertyUpdate(
  property: PropertyConfiguration,
  body: Record<string, unknown>,
): PropertyConfigurationInput {
  const input = propertyUpdateInput(property, body);
  const result = createPropertyConfiguration(input);
  if (!result.ok) {
    validationError(result.errors);
  }
  if (result.value.id !== property.id) {
    validationError([{ field: 'id', code: 'malformed_id' }]);
  }
  return input;
}

export function validateRateInput(body: Record<string, unknown>): RatePlan {
  requireAllowedKeys(body, RATE_FIELDS);
  const rawOverrides = body['seasonalOverrides'];
  if (rawOverrides !== undefined) {
    if (!Array.isArray(rawOverrides)) {
      validationError([{ field: 'seasonalOverrides', code: 'invalid_array' }]);
    }
    for (const [index, override] of rawOverrides.entries()) {
      if (!isPlainRecord(override)) {
        validationError([{ field: `seasonalOverrides[${index}]`, code: 'invalid_input' }]);
      }
      requireAllowedKeys(override, RATE_OVERRIDE_FIELDS);
    }
  }
  const result = createRatePlan(body);
  if (!result.ok) {
    validationError(result.errors);
  }
  return result.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_MANUAL_BLOCK_REASON = 500;

export function validateManualBlockInput(body: Record<string, unknown>): {
  readonly id: string;
  readonly arrival: string;
  readonly departure: string;
  readonly reason: string;
} {
  requireAllowedKeys(body, MANUAL_BLOCK_FIELDS);
  const id = body['id'];
  const arrival = body['arrival'];
  const departure = body['departure'];
  const reason = body['reason'];
  if (typeof id !== 'string' || !SAFE_IDENTIFIER.test(id)) {
    validationError([{ field: 'id', code: 'malformed_id' }]);
  }
  if (
    typeof arrival !== 'string' ||
    typeof departure !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(arrival) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(departure)
  ) {
    validationError([{ field: 'interval', code: 'invalid_stay' }]);
  }
  const dateResult = createLocalDateInterval({ arrival, departure });
  if (!dateResult.ok) {
    validationError([{ field: 'interval', code: 'invalid_stay' }]);
  }
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > MAX_MANUAL_BLOCK_REASON ||
    hasControlCharacters(reason)
  ) {
    validationError([{ field: 'reason', code: 'invalid_string' }]);
  }
  return {
    id,
    arrival,
    departure,
    reason: reason.trim(),
  };
}
