import { BED_CAPACITY_BY_TYPE } from './vocabulary.js';
import type { BedConfiguration, PropertyValidationError, PropertyType } from './types.js';
import { addValidationError } from './validation.js';

export function addCrossFieldErrors(
  propertyType: PropertyType,
  bedroomCount: number,
  bedConfiguration: readonly BedConfiguration[],
  bathroomCount: number,
  maximumGuests: number,
  errors: PropertyValidationError[],
): void {
  if (propertyType === 'studio' && bedroomCount !== 0) {
    addValidationError(
      errors,
      'bedroomCount',
      'impossible_configuration',
      'studio properties must have zero bedrooms.',
    );
  }
  if (propertyType !== 'studio' && bedroomCount === 0) {
    addValidationError(
      errors,
      'bedroomCount',
      'impossible_configuration',
      'non-studio properties must have at least one bedroom.',
    );
  }
  if (bathroomCount === 0) {
    addValidationError(
      errors,
      'bathroomCount',
      'impossible_configuration',
      'a property must have at least one bathroom.',
    );
  }
  if (maximumGuests === 0) {
    addValidationError(
      errors,
      'maximumGuests',
      'impossible_configuration',
      'a property must allow at least one guest.',
    );
  }

  const bedUnitCount = bedConfiguration.reduce((total, bed) => total + bed.quantity, 0);
  if (bedroomCount > bedUnitCount) {
    addValidationError(
      errors,
      'bedConfiguration',
      'impossible_configuration',
      'there must be at least one bed unit per bedroom.',
    );
  }

  const bedCapacity = bedConfiguration.reduce(
    (total, bed) => total + BED_CAPACITY_BY_TYPE[bed.type] * bed.quantity,
    0,
  );
  if (maximumGuests > bedCapacity) {
    addValidationError(
      errors,
      'maximumGuests',
      'exceeds_bed_capacity',
      'maximumGuests must not exceed the configured bed capacity.',
    );
  }
}
