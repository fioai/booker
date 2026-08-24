import { isPropertyConfiguration, type PropertyConfiguration } from '@booking-engine/booking-core';

import type {
  PublicBedConfigurationV1,
  PublicPropertyConfigurationV1,
} from '@booking-engine/sdk-typescript';

/** Explicit outward mapping; domain private fields are never copied into this object. */
export function serializePublicProperty(
  property: PropertyConfiguration,
): PublicPropertyConfigurationV1 {
  if (!isPropertyConfiguration(property)) {
    throw new TypeError('serializePublicProperty requires a canonical PropertyConfiguration.');
  }

  const bedConfiguration: readonly PublicBedConfigurationV1[] = Object.freeze(
    property.bedConfiguration.map((bed) => Object.freeze({ ...bed })),
  );
  const amenities = Object.freeze([...property.amenities]);

  return Object.freeze({
    id: property.id,
    name: property.name,
    summary: property.summary,
    country: property.country,
    timezone: property.timezone,
    currency: property.currency,
    propertyType: property.propertyType,
    bedroomCount: property.bedroomCount,
    bedConfiguration,
    bathroomCount: property.bathroomCount,
    maximumGuests: property.maximumGuests,
    amenities,
    hostNotes: property.hostNotes,
  });
}
