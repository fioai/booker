import {
  isPropertyConfigurationV1,
  type PropertyConfigurationV1,
} from '@lotus-booking/booking-core';

import type {
  PublicBedConfigurationV1,
  PublicPropertyConfigurationV1,
} from '@lotus-booking/sdk-typescript';

/** Explicit outward mapping; domain private fields are never copied into this object. */
export function serializePublicPropertyV1(
  property: PropertyConfigurationV1,
): PublicPropertyConfigurationV1 {
  if (!isPropertyConfigurationV1(property)) {
    throw new TypeError('serializePublicPropertyV1 requires a canonical PropertyConfigurationV1.');
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
