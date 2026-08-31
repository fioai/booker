import { describe, expect, it } from 'vitest';

import {
  createPropertyConfiguration,
  isPropertyConfiguration,
  PROPERTY_CONFIGURATION_LIMITS,
  type PropertyConfigurationInput,
  type PropertyConfiguration,
} from '@booking-engine/booking-core';
import { sampleBungalowFixture, syntheticHarbourLoftFixture } from './fixtures.js';

function withChanges(changes: Partial<PropertyConfigurationInput>): PropertyConfigurationInput {
  return { ...sampleBungalowFixture, ...changes };
}

function validConfiguration(
  input: PropertyConfigurationInput = sampleBungalowFixture,
): PropertyConfiguration {
  const result = createPropertyConfiguration(input);

  if (!result.ok) {
    throw new Error(result.errors.map(({ field, code }) => `${field}:${code}`).join(', '));
  }

  return result.value;
}

function expectErrors(input: unknown, expected: readonly (readonly [string, string])[]): void {
  const result = createPropertyConfiguration(input);

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.errors.map(({ field, code }) => [field, code])).toEqual(expected);
}

describe('PropertyConfiguration', () => {
  it.each([
    ['Sample Garden Bungalow', sampleBungalowFixture],
    ['synthetic harbour loft', syntheticHarbourLoftFixture],
  ])('accepts the %s fixture through the same contract', (_name, fixture) => {
    const result = createPropertyConfiguration(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(isPropertyConfiguration(result.value)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.bedConfiguration)).toBe(true);
    expect(Object.isFrozen(result.value.amenities)).toBe(true);
    expect(result.value.operationalNotes).toContain('PRIVATE');
  });

  it('keeps the canonical sample bungalow at two guests', () => {
    const configuration = validConfiguration();

    expect(configuration.maximumGuests).toBe(2);
    expect(configuration.timezone).toBe('America/Toronto');
    expect(configuration.bedConfiguration).toEqual([{ type: 'double', quantity: 1 }]);
  });

  it('accepts complete ISO geography and currency data including Brazil', () => {
    const configuration = validConfiguration(
      withChanges({ country: 'br', currency: 'brl', timezone: 'America/Sao_Paulo' }),
    );

    expect(configuration.country).toBe('BR');
    expect(configuration.currency).toBe('BRL');
  });

  it('rejects syntactically plausible non-codes and Unicode case folding', () => {
    expectErrors(withChanges({ country: 'QZ' }), [['country', 'unsupported_country']]);
    expectErrors(withChanges({ currency: 'ZZZ' }), [['currency', 'unsupported_currency']]);
    expectErrors(withChanges({ country: 'ſs' }), [['country', 'malformed_country']]);
    expectErrors(withChanges({ currency: 'ſgd' }), [['currency', 'malformed_currency']]);
  });

  it('canonicalizes supported IANA timezone aliases through the pinned runtime', () => {
    const configuration = validConfiguration(withChanges({ timezone: 'US/Eastern' }));

    expect(configuration.timezone).toBe('America/New_York');
  });

  it('rejects malformed top-level input with one deterministic error', () => {
    expectErrors(null, [['configuration', 'invalid_input']]);
    expectErrors([], [['configuration', 'invalid_input']]);
  });

  it('rejects structural objects as validated configurations at runtime', () => {
    const configuration = validConfiguration();
    const forged = { ...configuration } as unknown as PropertyConfiguration;

    expect(isPropertyConfiguration(forged)).toBe(false);
  });

  it('rejects reflective construction and subclass-shaped spoofs', () => {
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
    expect(() => Object.setPrototypeOf(configuration, ForgedSubclass.prototype)).toThrow();
  });

  it('rejects empty and oversized identifiers', () => {
    expectErrors(withChanges({ id: '' }), [['id', 'empty_string']]);
    expectErrors(
      withChanges({
        id: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.propertyIdMaxLength + 1),
      }),
      [['id', 'string_too_long']],
    );
    expectErrors(withChanges({ id: 'valid id' }), [['id', 'malformed_id']]);
    expectErrors(withChanges({ id: ' valid-id ' }), [['id', 'malformed_id']]);
  });

  it('rejects empty and oversized names', () => {
    expectErrors(withChanges({ name: '   ' }), [['name', 'empty_string']]);
    expectErrors(
      withChanges({
        name: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.nameMaxLength + 1),
      }),
      [['name', 'string_too_long']],
    );
    expectErrors(
      withChanges({
        summary: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.summaryMaxLength + 1),
      }),
      [['summary', 'string_too_long']],
    );
  });

  it('rejects invalid country, currency, and timezone values exactly', () => {
    expectErrors(withChanges({ country: 'C' }), [['country', 'malformed_country']]);
    expectErrors(withChanges({ currency: 'EU' }), [['currency', 'malformed_currency']]);
    expectErrors(withChanges({ timezone: 'not a timezone' }), [['timezone', 'malformed_timezone']]);
    expectErrors(withChanges({ timezone: 'Europe/Atlantis' }), [
      ['timezone', 'unsupported_timezone'],
    ]);
    expectErrors(
      withChanges({
        timezone: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.timezoneMaxLength + 1),
      }),
      [['timezone', 'string_too_long']],
    );
  });

  it('rejects unsupported and oversized property types', () => {
    expectErrors(withChanges({ propertyType: 'castle' }), [
      ['propertyType', 'unsupported_property_type'],
    ]);
    expectErrors(
      withChanges({
        propertyType: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.propertyTypeMaxLength + 1),
      }),
      [['propertyType', 'string_too_long']],
    );
  });

  it('rejects negative, non-integer, and excessive counts', () => {
    expectErrors(withChanges({ bedroomCount: -1 }), [['bedroomCount', 'negative_count']]);
    expectErrors(withChanges({ bedroomCount: 1.5 }), [['bedroomCount', 'invalid_count']]);
    expectErrors(
      withChanges({
        bedroomCount: PROPERTY_CONFIGURATION_LIMITS.maxBedroomCount + 1,
      }),
      [['bedroomCount', 'count_too_large']],
    );
    expectErrors(withChanges({ bathroomCount: -1 }), [['bathroomCount', 'negative_count']]);
    expectErrors(
      withChanges({
        bathroomCount: PROPERTY_CONFIGURATION_LIMITS.maxBathroomCount + 1,
      }),
      [['bathroomCount', 'count_too_large']],
    );
    expectErrors(withChanges({ maximumGuests: -1 }), [['maximumGuests', 'negative_count']]);
    expectErrors(
      withChanges({
        maximumGuests: PROPERTY_CONFIGURATION_LIMITS.maxGuests + 1,
      }),
      [['maximumGuests', 'count_too_large']],
    );
  });

  it('rejects impossible bedroom, bathroom, bed, and guest combinations', () => {
    expectErrors(withChanges({ propertyType: 'studio', bedroomCount: 1 }), [
      ['bedroomCount', 'impossible_configuration'],
    ]);
    expectErrors(withChanges({ propertyType: 'bungalow', bedroomCount: 0 }), [
      ['bedroomCount', 'impossible_configuration'],
    ]);
    expectErrors(withChanges({ bathroomCount: 0 }), [
      ['bathroomCount', 'impossible_configuration'],
    ]);
    expectErrors(withChanges({ maximumGuests: 0 }), [
      ['maximumGuests', 'impossible_configuration'],
    ]);
    expectErrors(withChanges({ bedConfiguration: [] }), [['bedConfiguration', 'empty_array']]);
    expectErrors(
      withChanges({
        bedConfiguration: [{ type: 'queen', quantity: 1 }],
        maximumGuests: 3,
      }),
      [['maximumGuests', 'exceeds_bed_capacity']],
    );
    expectErrors(withChanges({ bedConfiguration: [{ type: 'queen', quantity: 1.5 }] }), [
      ['bedConfiguration[0].quantity', 'invalid_count'],
    ]);
    expectErrors(
      withChanges({
        bedConfiguration: [
          {
            type: 'queen',
            quantity: PROPERTY_CONFIGURATION_LIMITS.maxBedQuantity + 1,
          },
        ],
      }),
      [['bedConfiguration[0].quantity', 'count_too_large']],
    );
    expectErrors(
      withChanges({
        bedConfiguration: [
          { type: 'queen', quantity: 1 },
          { type: 'queen', quantity: 1 },
        ],
      }),
      [['bedConfiguration[1].type', 'duplicate_bed_type']],
    );
  });

  it.each([
    ['single', 1],
    ['bunk', 2],
    ['double', 2],
    ['king', 2],
    ['queen', 2],
    ['sofa-bed', 2],
  ] as const)('enforces the %s bed capacity', (type, capacity) => {
    expectErrors(
      withChanges({
        bedConfiguration: [{ type, quantity: 1 }],
        maximumGuests: capacity + 1,
      }),
      [['maximumGuests', 'exceeds_bed_capacity']],
    );
  });

  it('rejects duplicate and oversized amenities', () => {
    expectErrors(withChanges({ amenities: ['Wi-Fi', ' wi-fi '] }), [
      ['amenities', 'duplicate_amenity'],
    ]);
    expectErrors(
      withChanges({
        amenities: Array.from(
          { length: PROPERTY_CONFIGURATION_LIMITS.maxAmenities + 1 },
          (_, index) => `amenity-${index}`,
        ),
      }),
      [['amenities', 'array_too_long']],
    );
    expectErrors(
      withChanges({
        amenities: ['x'.repeat(PROPERTY_CONFIGURATION_LIMITS.amenityMaxLength + 1)],
      }),
      [['amenities[0]', 'string_too_long']],
    );
  });

  it('rejects sparse arrays deterministically', () => {
    const sparseBeds: unknown[] = [];
    sparseBeds.length = 1;
    const sparseAmenities: unknown[] = [];
    sparseAmenities.length = 1;

    expectErrors(withChanges({ bedConfiguration: sparseBeds as never }), [
      ['bedConfiguration[0]', 'invalid_input'],
    ]);
    expectErrors(withChanges({ amenities: sparseAmenities as never }), [
      ['amenities[0]', 'invalid_input'],
    ]);
  });

  it('does not traverse entries beyond an oversized array bound', () => {
    const oversizedBeds: unknown[] = [];
    oversizedBeds.length = PROPERTY_CONFIGURATION_LIMITS.maxBedConfigurations + 1;
    Object.defineProperty(oversizedBeds, PROPERTY_CONFIGURATION_LIMITS.maxBedConfigurations, {
      get() {
        throw new Error('bed getter beyond bound was evaluated');
      },
      enumerable: true,
    });

    const oversizedAmenities: unknown[] = [];
    oversizedAmenities.length = PROPERTY_CONFIGURATION_LIMITS.maxAmenities + 1;
    Object.defineProperty(oversizedAmenities, PROPERTY_CONFIGURATION_LIMITS.maxAmenities, {
      get() {
        throw new Error('amenity getter beyond bound was evaluated');
      },
      enumerable: true,
    });

    expectErrors(withChanges({ bedConfiguration: oversizedBeds as never }), [
      ['bedConfiguration', 'array_too_long'],
    ]);
    expectErrors(withChanges({ amenities: oversizedAmenities as never }), [
      ['amenities', 'array_too_long'],
    ]);
  });

  it.each([
    ['C0', '\u0000'],
    ['C1', '\u0085'],
    ['bidi override', '\u202e'],
    ['bidi isolation', '\u2066'],
  ])('rejects %s controls in public text', (_name, control) => {
    expectErrors(withChanges({ name: `Guest visible ${control} text` }), [
      ['name', 'malformed_string'],
    ]);
  });

  it.each([
    ['id', 'id', (text: string) => withChanges({ id: text })],
    ['name', 'name', (text: string) => withChanges({ name: text })],
    ['summary', 'summary', (text: string) => withChanges({ summary: text })],
    ['country', 'country', (text: string) => withChanges({ country: text })],
    ['timezone', 'timezone', (text: string) => withChanges({ timezone: text })],
    ['currency', 'currency', (text: string) => withChanges({ currency: text })],
    ['property type', 'propertyType', (text: string) => withChanges({ propertyType: text })],
    [
      'bed type',
      'bedConfiguration[0].type',
      (text: string) =>
        withChanges({
          bedConfiguration: [{ type: text, quantity: 1 }],
        }),
    ],
    [
      'amenity',
      'amenities[0]',
      (text: string) =>
        withChanges({
          amenities: [text],
        }),
    ],
    ['host notes', 'hostNotes', (text: string) => withChanges({ hostNotes: text })],
    [
      'operational notes',
      'operationalNotes',
      (text: string) => withChanges({ operationalNotes: text }),
    ],
  ] as const)('rejects lone surrogates in canonical %s text', (_name, field, inputFor) => {
    for (const loneSurrogate of ['\ud83c', '\udfe0']) {
      expectErrors(inputFor(loneSurrogate), [[field, 'malformed_string']]);
    }
  });

  it.each([
    [
      'name',
      (text: string) => withChanges({ name: `Astral ${text}` }),
      (configuration: PropertyConfiguration) => configuration.name,
    ],
    [
      'summary',
      (text: string) => withChanges({ summary: `Astral ${text}` }),
      (configuration: PropertyConfiguration) => configuration.summary,
    ],
    [
      'amenity',
      (text: string) => withChanges({ amenities: [`Astral ${text}`] }),
      (configuration: PropertyConfiguration) => configuration.amenities[0],
    ],
    [
      'host notes',
      (text: string) => withChanges({ hostNotes: `Astral ${text}` }),
      (configuration: PropertyConfiguration) => configuration.hostNotes,
    ],
    [
      'operational notes',
      (text: string) => withChanges({ operationalNotes: `Astral ${text}` }),
      (configuration: PropertyConfiguration) => configuration.operationalNotes,
    ],
  ] as const)('accepts valid astral pairs in canonical %s text', (_name, inputFor, readText) => {
    const astralPair = '\ud83c\udfe0';
    const configuration = validConfiguration(inputFor(astralPair));

    expect(readText(configuration)).toContain(astralPair);
  });

  it('accepts null-prototype own-property records', () => {
    const inputRecord = Object.assign(Object.create(null), sampleBungalowFixture) as Record<
      string,
      unknown
    >;
    inputRecord['bedConfiguration'] = sampleBungalowFixture.bedConfiguration.map((bed) =>
      Object.assign(Object.create(null), bed),
    );
    const input = inputRecord as unknown as PropertyConfigurationInput;

    expect(createPropertyConfiguration(input).ok).toBe(true);
  });

  it('rejects custom prototypes, inherited fields, and unknown keys', () => {
    const customPrototype = Object.create({ country: 'BR' });
    Object.assign(customPrototype, sampleBungalowFixture);
    expectErrors(customPrototype, [['configuration', 'invalid_input']]);

    const inputWithoutCountry = { ...sampleBungalowFixture } as Record<string, unknown>;
    delete inputWithoutCountry['country'];
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const previousCountry = objectPrototype['country'];
    Object.defineProperty(objectPrototype, 'country', {
      value: 'BR',
      configurable: true,
    });
    try {
      expectErrors(inputWithoutCountry, [['country', 'missing_field']]);
    } finally {
      if (previousCountry === undefined) {
        delete objectPrototype['country'];
      } else {
        Object.defineProperty(objectPrototype, 'country', {
          value: previousCountry,
          configurable: true,
        });
      }
    }

    expectErrors(withChanges({ timeZone: 'US/Eastern' } as never), [
      ['configuration.timeZone', 'unknown_field'],
    ]);
    expectErrors(withChanges({ maxGuests: 3 } as never), [
      ['configuration.maxGuests', 'unknown_field'],
    ]);
    expectErrors(
      withChanges({
        bedConfiguration: [{ type: 'queen', quantity: 1, notes: 'private' } as never],
      }),
      [['bedConfiguration[0].notes', 'unknown_field']],
    );
  });

  it('rejects oversized public and private notes', () => {
    expectErrors(
      withChanges({
        hostNotes: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.hostNotesMaxLength + 1),
      }),
      [['hostNotes', 'string_too_long']],
    );
    expectErrors(
      withChanges({
        operationalNotes: 'x'.repeat(PROPERTY_CONFIGURATION_LIMITS.operationalNotesMaxLength + 1),
      }),
      [['operationalNotes', 'string_too_long']],
    );
  });

  it('does not expose private notes through default JSON or stringification', () => {
    const configuration = validConfiguration();
    expect(JSON.stringify(configuration)).not.toContain('PRIVATE SAMPLE MARKER');
    expect(String(configuration)).not.toContain('PRIVATE SAMPLE MARKER');
  });
});
