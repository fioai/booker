import { describe, expect, it } from 'vitest';

import {
  createPropertyConfigurationV1,
  isPropertyConfigurationV1,
  type PropertyConfigurationInputV1,
  type PropertyConfigurationV1,
} from '@lotus-booking/booking-core';
import type { PublicPropertyConfigurationV1 } from '@lotus-booking/sdk-typescript';

import { serializePublicPropertyV1 } from '../src/index.js';
import { sampleBungalowFixture } from '../../../packages/booking-core/test/property-fixtures.js';

function validConfiguration(
  input: PropertyConfigurationInputV1 = sampleBungalowFixture,
): PropertyConfigurationV1 {
  const result = createPropertyConfigurationV1(input);

  if (!result.ok) {
    throw new Error(result.errors.map(({ field, code }) => `${field}:${code}`).join(', '));
  }

  return result.value;
}

describe('API public property serialization', () => {
  it('rejects forged structural objects at the API boundary', () => {
    const forged = { ...validConfiguration() } as unknown as PropertyConfigurationV1;

    expect(isPropertyConfigurationV1(forged)).toBe(false);
    expect(() => serializePublicPropertyV1(forged)).toThrow(
      'serializePublicPropertyV1 requires a canonical PropertyConfigurationV1.',
    );
  });

  it('rejects reflective construction and subclass-shaped spoofs at the API boundary', () => {
    const configuration = validConfiguration();
    const implementationConstructor = Object.getPrototypeOf(configuration).constructor as new (
      ...args: never[]
    ) => object;

    expect(() => new implementationConstructor()).toThrow(
      'PropertyConfigurationV1 instances can only be created by the factory.',
    );

    class ForgedSubclass extends implementationConstructor {}
    const forgedSubclass = Object.create(ForgedSubclass.prototype) as PropertyConfigurationV1;

    expect(forgedSubclass).toBeInstanceOf(ForgedSubclass);
    expect(isPropertyConfigurationV1(forgedSubclass)).toBe(false);
    expect(() => serializePublicPropertyV1(forgedSubclass)).toThrow(
      'serializePublicPropertyV1 requires a canonical PropertyConfigurationV1.',
    );
    expect(() => Object.setPrototypeOf(configuration, ForgedSubclass.prototype)).toThrow();
  });

  it('serializes only the versioned public representation', () => {
    const configuration = validConfiguration();
    const publicProperty: PublicPropertyConfigurationV1 = serializePublicPropertyV1(configuration);

    expect(Object.keys(publicProperty).sort()).toEqual([
      'amenities',
      'bathroomCount',
      'bedConfiguration',
      'bedroomCount',
      'country',
      'currency',
      'hostNotes',
      'id',
      'maximumGuests',
      'name',
      'propertyType',
      'summary',
      'timezone',
    ]);
    expect('operationalNotes' in publicProperty).toBe(false);
    expect(JSON.stringify(publicProperty)).not.toContain('operationalNotes');
    expect(JSON.stringify(publicProperty)).not.toContain('PRIVATE SAMPLE MARKER');
    expect(JSON.stringify(publicProperty)).toContain(
      'A quiet sample property for local verification.',
    );
  });

  it('does not expose private notes through the public SDK type', () => {
    const publicProperty = serializePublicPropertyV1(validConfiguration());

    // @ts-expect-error Private operational notes are not part of the public v1 contract.
    const privateNotes = publicProperty.operationalNotes;
    void privateNotes;
  });
});
