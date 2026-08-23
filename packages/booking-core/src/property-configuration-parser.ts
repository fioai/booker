import { ISO_3166_1_ALPHA_2_CODES_V1 } from './iso-3166-1-alpha-2.js';
import { ISO_4217_ACTIVE_CODES_V1 } from './iso-4217-active.js';
import { addCrossFieldErrorsV1 } from './property-configuration-invariants.js';
import { readAmenitiesV1, readBedConfigurationV1 } from './property-configuration-arrays.js';
import { PROPERTY_CONFIGURATION_LIMITS_V1 } from './property-configuration-limits.js';
import { PROPERTY_TYPES_V1 } from './property-configuration-vocabulary.js';
import type {
  PropertyConfigurationStateV1,
  PropertyTypeV1,
  PropertyValidationErrorV1,
  ResultV1,
} from './property-configuration-types.js';
import {
  addUnknownFieldErrorsV1,
  addValidationErrorV1,
  failureV1,
  isPlainRecordV1,
  readCountV1,
  readCountryV1,
  readCurrencyV1,
  readIdentifierV1,
  readOwnV1,
  readTextV1,
  successV1,
} from './property-configuration-validation.js';
import { readTimezoneV1 } from './property-configuration-timezone.js';

type PropertyStateResultV1 = ResultV1<PropertyConfigurationStateV1, PropertyValidationErrorV1>;

const TOP_LEVEL_FIELDS_V1 = new Set([
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

function readPropertyTypeV1(
  value: unknown,
  errors: PropertyValidationErrorV1[],
): PropertyTypeV1 | undefined {
  const propertyType = readTextV1(
    value,
    'propertyType',
    PROPERTY_CONFIGURATION_LIMITS_V1.propertyTypeMaxLength,
    errors,
  );
  if (propertyType === undefined) {
    return undefined;
  }

  if (!PROPERTY_TYPES_V1.has(propertyType as PropertyTypeV1)) {
    addValidationErrorV1(
      errors,
      'propertyType',
      'unsupported_property_type',
      'propertyType is not supported.',
    );
    return undefined;
  }

  return propertyType as PropertyTypeV1;
}

export function parsePropertyConfigurationV1(input: unknown): PropertyStateResultV1 {
  const errors: PropertyValidationErrorV1[] = [];
  if (!isPlainRecordV1(input)) {
    addValidationErrorV1(
      errors,
      'configuration',
      'invalid_input',
      'property configuration must be a plain object.',
    );
    return failureV1(errors);
  }

  addUnknownFieldErrorsV1(input, 'configuration', TOP_LEVEL_FIELDS_V1, errors);

  const id = readIdentifierV1(
    readOwnV1(input, 'id'),
    PROPERTY_CONFIGURATION_LIMITS_V1.propertyIdMaxLength,
    errors,
  );
  const name = readTextV1(
    readOwnV1(input, 'name'),
    'name',
    PROPERTY_CONFIGURATION_LIMITS_V1.nameMaxLength,
    errors,
  );
  const summary = readTextV1(
    readOwnV1(input, 'summary'),
    'summary',
    PROPERTY_CONFIGURATION_LIMITS_V1.summaryMaxLength,
    errors,
  );
  const country = readCountryV1(
    readOwnV1(input, 'country'),
    PROPERTY_CONFIGURATION_LIMITS_V1.countryCodeLength,
    ISO_3166_1_ALPHA_2_CODES_V1,
    errors,
  );
  const timezone = readTimezoneV1(
    readOwnV1(input, 'timezone'),
    PROPERTY_CONFIGURATION_LIMITS_V1.timezoneMaxLength,
    errors,
  );
  const currency = readCurrencyV1(
    readOwnV1(input, 'currency'),
    PROPERTY_CONFIGURATION_LIMITS_V1.currencyCodeLength,
    ISO_4217_ACTIVE_CODES_V1,
    errors,
  );
  const propertyType = readPropertyTypeV1(readOwnV1(input, 'propertyType'), errors);
  const bedroomCount = readCountV1(
    readOwnV1(input, 'bedroomCount'),
    'bedroomCount',
    PROPERTY_CONFIGURATION_LIMITS_V1.maxBedroomCount,
    errors,
  );
  const bedConfiguration = readBedConfigurationV1(readOwnV1(input, 'bedConfiguration'), errors);
  const bathroomCount = readCountV1(
    readOwnV1(input, 'bathroomCount'),
    'bathroomCount',
    PROPERTY_CONFIGURATION_LIMITS_V1.maxBathroomCount,
    errors,
  );
  const maximumGuests = readCountV1(
    readOwnV1(input, 'maximumGuests'),
    'maximumGuests',
    PROPERTY_CONFIGURATION_LIMITS_V1.maxGuests,
    errors,
  );
  const amenities = readAmenitiesV1(readOwnV1(input, 'amenities'), errors);
  const hostNotes = readTextV1(
    readOwnV1(input, 'hostNotes'),
    'hostNotes',
    PROPERTY_CONFIGURATION_LIMITS_V1.hostNotesMaxLength,
    errors,
  );
  const operationalNotes = readTextV1(
    readOwnV1(input, 'operationalNotes'),
    'operationalNotes',
    PROPERTY_CONFIGURATION_LIMITS_V1.operationalNotesMaxLength,
    errors,
  );

  if (errors.length > 0) {
    return failureV1(errors);
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
    return failureV1(errors);
  }

  addCrossFieldErrorsV1(
    propertyType,
    bedroomCount,
    bedConfiguration,
    bathroomCount,
    maximumGuests,
    errors,
  );
  if (errors.length > 0) {
    return failureV1(errors);
  }

  return successV1({
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

export function freezePropertyConfigurationStateV1(
  state: PropertyConfigurationStateV1,
): PropertyConfigurationStateV1 {
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
