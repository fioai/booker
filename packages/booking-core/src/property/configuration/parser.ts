import { ISO_3166_1_ALPHA_2_CODES } from '../../iso-3166-1-alpha-2.js';
import { ISO_4217_ACTIVE_CODES } from '../../iso-4217-active.js';
import { addCrossFieldErrors } from './invariants.js';
import { readAmenities, readBedConfiguration } from './arrays.js';
import { PROPERTY_CONFIGURATION_LIMITS } from './limits.js';
import { PROPERTY_TYPES } from './vocabulary.js';
import type {
  PropertyConfigurationState,
  PropertyType,
  PropertyValidationError,
  Result,
} from './types.js';
import {
  addUnknownFieldErrors,
  addValidationError,
  failure,
  isPlainRecord,
  readCount,
  readCountry,
  readCurrency,
  readIdentifier,
  readOwn,
  readText,
  success,
} from './validation.js';
import { readTimezone } from './timezone.js';

type PropertyStateResult = Result<PropertyConfigurationState, PropertyValidationError>;

const TOP_LEVEL_FIELDS = new Set([
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

function readPropertyType(
  value: unknown,
  errors: PropertyValidationError[],
): PropertyType | undefined {
  const propertyType = readText(
    value,
    'propertyType',
    PROPERTY_CONFIGURATION_LIMITS.propertyTypeMaxLength,
    errors,
  );
  if (propertyType === undefined) {
    return undefined;
  }

  if (!PROPERTY_TYPES.has(propertyType as PropertyType)) {
    addValidationError(
      errors,
      'propertyType',
      'unsupported_property_type',
      'propertyType is not supported.',
    );
    return undefined;
  }

  return propertyType as PropertyType;
}

export function parsePropertyConfiguration(input: unknown): PropertyStateResult {
  const errors: PropertyValidationError[] = [];
  if (!isPlainRecord(input)) {
    addValidationError(
      errors,
      'configuration',
      'invalid_input',
      'property configuration must be a plain object.',
    );
    return failure(errors);
  }

  addUnknownFieldErrors(input, 'configuration', TOP_LEVEL_FIELDS, errors);

  const id = readIdentifier(
    readOwn(input, 'id'),
    PROPERTY_CONFIGURATION_LIMITS.propertyIdMaxLength,
    errors,
  );
  const name = readText(
    readOwn(input, 'name'),
    'name',
    PROPERTY_CONFIGURATION_LIMITS.nameMaxLength,
    errors,
  );
  const summary = readText(
    readOwn(input, 'summary'),
    'summary',
    PROPERTY_CONFIGURATION_LIMITS.summaryMaxLength,
    errors,
  );
  const country = readCountry(
    readOwn(input, 'country'),
    PROPERTY_CONFIGURATION_LIMITS.countryCodeLength,
    ISO_3166_1_ALPHA_2_CODES,
    errors,
  );
  const timezone = readTimezone(
    readOwn(input, 'timezone'),
    PROPERTY_CONFIGURATION_LIMITS.timezoneMaxLength,
    errors,
  );
  const currency = readCurrency(
    readOwn(input, 'currency'),
    PROPERTY_CONFIGURATION_LIMITS.currencyCodeLength,
    ISO_4217_ACTIVE_CODES,
    errors,
  );
  const propertyType = readPropertyType(readOwn(input, 'propertyType'), errors);
  const bedroomCount = readCount(
    readOwn(input, 'bedroomCount'),
    'bedroomCount',
    PROPERTY_CONFIGURATION_LIMITS.maxBedroomCount,
    errors,
  );
  const bedConfiguration = readBedConfiguration(readOwn(input, 'bedConfiguration'), errors);
  const bathroomCount = readCount(
    readOwn(input, 'bathroomCount'),
    'bathroomCount',
    PROPERTY_CONFIGURATION_LIMITS.maxBathroomCount,
    errors,
  );
  const maximumGuests = readCount(
    readOwn(input, 'maximumGuests'),
    'maximumGuests',
    PROPERTY_CONFIGURATION_LIMITS.maxGuests,
    errors,
  );
  const amenities = readAmenities(readOwn(input, 'amenities'), errors);
  const hostNotes = readText(
    readOwn(input, 'hostNotes'),
    'hostNotes',
    PROPERTY_CONFIGURATION_LIMITS.hostNotesMaxLength,
    errors,
  );
  const operationalNotes = readText(
    readOwn(input, 'operationalNotes'),
    'operationalNotes',
    PROPERTY_CONFIGURATION_LIMITS.operationalNotesMaxLength,
    errors,
  );

  if (errors.length > 0) {
    return failure(errors);
  }

  if (
    id === undefined ||
    name === undefined ||
    summary === undefined ||
    country === undefined ||
    timezone === undefined ||
    currency === undefined ||
    propertyType === undefined ||
    bedroomCount === undefined ||
    bedConfiguration === undefined ||
    bathroomCount === undefined ||
    maximumGuests === undefined ||
    amenities === undefined ||
    hostNotes === undefined ||
    operationalNotes === undefined
  ) {
    return failure(errors);
  }

  addCrossFieldErrors(
    propertyType,
    bedroomCount,
    bedConfiguration,
    bathroomCount,
    maximumGuests,
    errors,
  );
  if (errors.length > 0) {
    return failure(errors);
  }

  return success({
    id,
    name,
    summary,
    country,
    timezone,
    currency,
    propertyType,
    bedroomCount,
    bedConfiguration,
    bathroomCount,
    maximumGuests,
    amenities,
    hostNotes,
    operationalNotes,
  });
}

export function freezePropertyConfigurationState(
  state: PropertyConfigurationState,
): PropertyConfigurationState {
  const bedConfiguration = Object.freeze(
    state.bedConfiguration.map((bed) => Object.freeze({ ...bed })),
  );
  const amenities = Object.freeze([...state.amenities]);

  return Object.freeze({
    ...state,
    bedConfiguration,
    amenities,
  });
}
