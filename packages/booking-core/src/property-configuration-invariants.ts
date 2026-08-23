import { BED_CAPACITY_BY_TYPE_V1 } from './property-configuration-vocabulary.js';
import type {
  BedConfigurationV1,
  PropertyValidationErrorV1,
  PropertyTypeV1,
} from './property-configuration-types.js';
import { addValidationErrorV1 } from './property-configuration-validation.js';

export function addCrossFieldErrorsV1(
  propertyType: PropertyTypeV1,
  bedroomCount: number,
  bedConfiguration: readonly BedConfigurationV1[],
  bathroomCount: number,
  maximumGuests: number,
  errors: PropertyValidationErrorV1[],
): void {
  if (propertyType === 'studio' && bedroomCount !== 0) {
    addValidationErrorV1(
      errors,
      'bedroomCount',
      'impossible_configuration',
      'studio properties must have zero bedrooms.',
    );
  }
  if (propertyType !== 'studio' && bedroomCount === 0) {
    addValidationErrorV1(
      errors,
      'bedroomCount',
      'impossible_configuration',
      'non-studio properties must have at least one bedroom.',
    );
  }
  if (bathroomCount === 0) {
    addValidationErrorV1(
      errors,
      'bathroomCount',
      'impossible_configuration',
      'a property must have at least one bathroom.',
    );
  }
  if (maximumGuests === 0) {
    addValidationErrorV1(
      errors,
      'maximumGuests',
      'impossible_configuration',
      'a property must allow at least one guest.',
    );
  }

  const bedUnitCount = bedConfiguration.reduce((total, bed) => total + bed.quantity, 0);
  if (bedroomCount > bedUnitCount) {
    addValidationErrorV1(
      errors,
      'bedConfiguration',
      'impossible_configuration',
      'there must be at least one bed unit per bedroom.',
    );
  }

  const bedCapacity = bedConfiguration.reduce(
    (total, bed) => total + BED_CAPACITY_BY_TYPE_V1[bed.type] * bed.quantity,
    0,
  );
  if (maximumGuests > bedCapacity) {
    addValidationErrorV1(
      errors,
      'maximumGuests',
      'exceeds_bed_capacity',
      'maximumGuests must not exceed the configured bed capacity.',
    );
  }
}
