import { BED_TYPES } from './vocabulary.js';
import { PROPERTY_CONFIGURATION_LIMITS } from './limits.js';
import type { BedConfiguration, BedType, PropertyValidationError } from './types.js';
import {
  addUnknownFieldErrors,
  addValidationError,
  hasOwn,
  isPlainRecord,
  readCount,
  readOwn,
  readText,
} from './validation.js';

const BED_CONFIGURATION_FIELDS = new Set(['type', 'quantity']);

function readBedEntry(
  entry: unknown,
  index: number,
  seenTypes: Set<BedType>,
  errors: PropertyValidationError[],
): BedConfiguration | undefined {
  const field = `bedConfiguration[${index}]`;
  if (!isPlainRecord(entry)) {
    addValidationError(errors, field, 'invalid_input', `${field} must be a plain object.`);
    return undefined;
  }

  addUnknownFieldErrors(entry, field, BED_CONFIGURATION_FIELDS, errors);
  const errorsBeforeEntry = errors.length;
  const bedType = readText(
    readOwn(entry, 'type'),
    `${field}.type`,
    PROPERTY_CONFIGURATION_LIMITS.bedTypeMaxLength,
    errors,
  );
  let validatedType: BedType | undefined;
  if (bedType !== undefined) {
    if (!BED_TYPES.has(bedType as BedType)) {
      addValidationError(
        errors,
        `${field}.type`,
        'unsupported_bed_type',
        'bed type is not supported.',
      );
    } else {
      validatedType = bedType as BedType;
      if (seenTypes.has(validatedType)) {
        addValidationError(
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

  const quantity = readCount(
    readOwn(entry, 'quantity'),
    `${field}.quantity`,
    PROPERTY_CONFIGURATION_LIMITS.maxBedQuantity,
    errors,
  );
  if (quantity === 0) {
    addValidationError(
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

export function readBedConfiguration(
  value: unknown,
  errors: PropertyValidationError[],
): readonly BedConfiguration[] | undefined {
  if (!Array.isArray(value)) {
    addValidationError(
      errors,
      'bedConfiguration',
      'invalid_array',
      'bedConfiguration must be an array.',
    );
    return undefined;
  }

  if (value.length === 0) {
    addValidationError(
      errors,
      'bedConfiguration',
      'empty_array',
      'bedConfiguration must not be empty.',
    );
    return undefined;
  }

  if (value.length > PROPERTY_CONFIGURATION_LIMITS.maxBedConfigurations) {
    addValidationError(
      errors,
      'bedConfiguration',
      'array_too_long',
      `bedConfiguration must contain at most ${PROPERTY_CONFIGURATION_LIMITS.maxBedConfigurations} entries.`,
    );
    return undefined;
  }

  const seenTypes = new Set<BedType>();
  const beds: BedConfiguration[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `bedConfiguration[${index}]`;
    if (!hasOwn(value as unknown as Record<string, unknown>, String(index))) {
      addValidationError(errors, field, 'invalid_input', `${field} must be present.`);
      continue;
    }

    try {
      const bed = readBedEntry(value[index], index, seenTypes, errors);
      if (bed !== undefined) {
        beds.push(bed);
      }
    } catch {
      addValidationError(errors, field, 'invalid_input', `${field} could not be read.`);
    }
  }

  return beds;
}

export function readAmenities(
  value: unknown,
  errors: PropertyValidationError[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addValidationError(errors, 'amenities', 'invalid_array', 'amenities must be an array.');
    return undefined;
  }

  if (value.length > PROPERTY_CONFIGURATION_LIMITS.maxAmenities) {
    addValidationError(
      errors,
      'amenities',
      'array_too_long',
      `amenities must contain at most ${PROPERTY_CONFIGURATION_LIMITS.maxAmenities} entries.`,
    );
    return undefined;
  }

  const seenAmenities = new Set<string>();
  const amenities: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `amenities[${index}]`;
    if (!hasOwn(value as unknown as Record<string, unknown>, String(index))) {
      addValidationError(errors, field, 'invalid_input', `${field} must be present.`);
      continue;
    }

    let amenity: string | undefined;
    try {
      amenity = readText(
        value[index],
        field,
        PROPERTY_CONFIGURATION_LIMITS.amenityMaxLength,
        errors,
      );
    } catch {
      addValidationError(errors, field, 'invalid_input', `${field} could not be read.`);
      continue;
    }

    if (amenity === undefined) {
      continue;
    }

    const key = amenity.toLocaleLowerCase('en-US');
    if (seenAmenities.has(key)) {
      addValidationError(
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
