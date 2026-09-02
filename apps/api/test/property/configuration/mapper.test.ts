import { describe, expect, it } from 'vitest';

import {
  createPropertyConfiguration,
  isPropertyConfiguration,
  type PropertyConfigurationInput,
  type PropertyConfiguration,
} from '@booking-engine/booking-core';
import {
  createBookingEngineClientV1,
  type PublicPropertyConfigurationV1,
} from '@booking-engine/sdk-typescript';

import { serializePublicProperty } from '../../../src/index.js';
import { sampleBungalowFixture } from '../../../../../packages/booking-core/test/property/fixtures.js';

function validConfiguration(
  input: PropertyConfigurationInput = sampleBungalowFixture,
): PropertyConfiguration {
  const result = createPropertyConfiguration(input);

  if (!result.ok) {
    throw new Error(result.errors.map(({ field, code }) => `${field}:${code}`).join(', '));
  }

  return result.value;
}

describe('API public property serialization', () => {
  it('rejects forged structural objects at the API boundary', () => {
    const forged = { ...validConfiguration() } as unknown as PropertyConfiguration;

    expect(isPropertyConfiguration(forged)).toBe(false);
    expect(() => serializePublicProperty(forged)).toThrow(
      'serializePublicProperty requires a canonical PropertyConfiguration.',
    );
  });

  it('rejects reflective construction and subclass-shaped spoofs at the API boundary', () => {
    const configuration = validConfiguration();
    const implementationConstructor = Object.getPrototypeOf(configuration).constructor as new (
      ...args: never[]
    ) => object;

    expect(() => new implementationConstructor()).toThrow(
      'PropertyConfiguration instances can only be created by the factory.',
    );

    class ForgedSubclass extends implementationConstructor {}
    const forgedSubclass = Object.create(ForgedSubclass.prototype) as PropertyConfiguration;

    expect(forgedSubclass).toBeInstanceOf(ForgedSubclass);
    expect(isPropertyConfiguration(forgedSubclass)).toBe(false);
    expect(() => serializePublicProperty(forgedSubclass)).toThrow(
      'serializePublicProperty requires a canonical PropertyConfiguration.',
    );
    expect(() => Object.setPrototypeOf(configuration, ForgedSubclass.prototype)).toThrow();
  });

  it('serializes only the versioned public representation', () => {
    const configuration = validConfiguration();
    const publicProperty: PublicPropertyConfigurationV1 = serializePublicProperty(configuration);

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

  it('produces astral text accepted by the public SDK response boundary', async () => {
    const astralPair = '\ud83c\udfe0';
    const publicProperty = serializePublicProperty(
      validConfiguration({
        ...sampleBungalowFixture,
        name: `Astral ${astralPair}`,
        summary: `Astral ${astralPair} summary`,
        amenities: [`Astral ${astralPair} amenity`],
        hostNotes: `Astral ${astralPair} host notes`,
      }),
    );
    const client = createBookingEngineClientV1({
      baseUrl: 'https://api.example.test',
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => publicProperty,
      }),
    });

    await expect(client.getProperty(publicProperty.id)).resolves.toEqual(publicProperty);
  });

  it('does not expose private notes through the public SDK type', () => {
    const publicProperty = serializePublicProperty(validConfiguration());

    // @ts-expect-error Private operational notes are not part of the public v1 contract.
    const privateNotes = publicProperty.operationalNotes;
    void privateNotes;
  });
});
