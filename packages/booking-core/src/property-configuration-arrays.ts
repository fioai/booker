import { BED_TYPES_V1 } from './property-configuration-vocabulary.js';
import { PROPERTY_CONFIGURATION_LIMITS_V1 } from './property-configuration-limits.js';
import type {
  BedConfigurationV1,
  BedTypeV1,
  PropertyValidationErrorV1,
} from './property-configuration-types.js';
import {
  addUnknownFieldErrorsV1,
  addValidationErrorV1,
  hasOwnV1,
  isPlainRecordV1,
  readCountV1,
  readOwnV1,
  readTextV1,
} from './property-configuration-validation.js';

const BED_CONFIGURATION_FIELDS_V1 = new Set(['type', 'quantity']);

function readBedEntryV1(
  entry: unknown,
  index: number,
  seenTypes: Set<BedTypeV1>,
  errors: PropertyValidationErrorV1[],
): BedConfigurationV1 | undefined {
  const field = `bedConfiguration[${index}]`;
  if (!isPlainRecordV1(entry)) {
    addValidationErrorV1(errors, field, 'invalid_input', `${field} must be a plain object.`);
    return undefined;
  }

  addUnknownFieldErrorsV1(entry, field, BED_CONFIGURATION_FIELDS_V1, errors);
  const errorsBeforeEntry = errors.length;
  const bedType = readTextV1(
    readOwnV1(entry, 'type'),
    `${field}.type`,
    PROPERTY_CONFIGURATION_LIMITS_V1.bedTypeMaxLength,
    errors,
  );
  let validatedType: BedTypeV1 | undefined;
  if (bedType !== undefined) {
    if (!BED_TYPES_V1.has(bedType as BedTypeV1)) {
      addValidationErrorV1(
        errors,
        `${field}.type`,
        'unsupported_bed_type',
        'bed type is not supported.',
      );
    } else {
      validatedType = bedType as BedTypeV1;
      if (seenTypes.has(validatedType)) {
        addValidationErrorV1(
          errors,
          `${field}.type`,
          'duplicate_bed_type',
          'bed types must not be repeated.',
        );
      } else {
        seenTypes.add(validatedType);
      }
    }
  }

  const quantity = readCountV1(
    readOwnV1(entry, 'quantity'),
    `${field}.quantity`,
    PROPERTY_CONFIGURATION_LIMITS_V1.maxBedQuantity,
    errors,
  );
  if (quantity === 0) {
    addValidationErrorV1(
      errors,
      `${field}.quantity`,
      'impossible_configuration',
      'each bed type needs at least one bed.',
    );
  }

  if (
    errors.length !== errorsBeforeEntry ||
    validatedType === undefined ||
    quantity === undefined ||
    quantity === 0
  ) {
    return undefined;
  }

  return { type: validatedType, quantity };
}

export function readBedConfigurationV1(
  value: unknown,
  errors: PropertyValidationErrorV1[],
): readonly BedConfigurationV1[] | undefined {
  if (!Array.isArray(value)) {
    addValidationErrorV1(
      errors,
      'bedConfiguration',
      'invalid_array',
      'bedConfiguration must be an array.',
    );
    return undefined;
  }

  if (value.length === 0) {
    addValidationErrorV1(
      errors,
      'bedConfiguration',
      'empty_array',
      'bedConfiguration must not be empty.',
    );
    return undefined;
  }

  if (value.length > PROPERTY_CONFIGURATION_LIMITS_V1.maxBedConfigurations) {
    addValidationErrorV1(
      errors,
      'bedConfiguration',
      'array_too_long',
      `bedConfiguration must contain at most ${PROPERTY_CONFIGURATION_LIMITS_V1.maxBedConfigurations} entries.`,
    );
    return undefined;
  }

  const seenTypes = new Set<BedTypeV1>();
  const beds: BedConfigurationV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `bedConfiguration[${index}]`;
    if (!hasOwnV1(value as unknown as Record<string, unknown>, String(index))) {
      addValidationErrorV1(errors, field, 'invalid_input', `${field} must be present.`);
      continue;
    }

    try {
      const bed = readBedEntryV1(value[index], index, seenTypes, errors);
      if (bed !== undefined) {
        beds.push(bed);
      }
    } catch {
      addValidationErrorV1(errors, field, 'invalid_input', `${field} could not be read.`);
    }
  }

  return beds;
}

export function readAmenitiesV1(
  value: unknown,
  errors: PropertyValidationErrorV1[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addValidationErrorV1(errors, 'amenities', 'invalid_array', 'amenities must be an array.');
    return undefined;
  }

  if (value.length > PROPERTY_CONFIGURATION_LIMITS_V1.maxAmenities) {
    addValidationErrorV1(
      errors,
      'amenities',
      'array_too_long',
      `amenities must contain at most ${PROPERTY_CONFIGURATION_LIMITS_V1.maxAmenities} entries.`,
    );
    return undefined;
  }

  const seenAmenities = new Set<string>();
  const amenities: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `amenities[${index}]`;
    if (!hasOwnV1(value as unknown as Record<string, unknown>, String(index))) {
      addValidationErrorV1(errors, field, 'invalid_input', `${field} must be present.`);
      continue;
    }

    let amenity: string | undefined;
    try {
      amenity = readTextV1(
        value[index],
        field,
        PROPERTY_CONFIGURATION_LIMITS_V1.amenityMaxLength,
        errors,
      );
    } catch {
      addValidationErrorV1(errors, field, 'invalid_input', `${field} could not be read.`);
      continue;
    }

    if (amenity === undefined) {
      continue;
    }

    const key = amenity.toLocaleLowerCase('en-US');
    if (seenAmenities.has(key)) {
      addValidationErrorV1(
        errors,
        'amenities',
        'duplicate_amenity',
        'amenities must not contain duplicates.',
      );
      continue;
    }

    seenAmenities.add(key);
    amenities.push(amenity);
  }

  return amenities;
}
