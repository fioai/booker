import type { PropertyConfigurationInput } from '../../src/index.js';

export const sampleBungalowFixture: PropertyConfigurationInput = {
  id: 'sample-bungalow',
  name: 'Sample Garden Bungalow',
  summary: 'A one-bedroom bungalow with a private garden for short stays.',
  country: 'CA',
  timezone: 'America/Toronto',
  currency: 'CAD',
  propertyType: 'bungalow',
  bedroomCount: 1,
  bedConfiguration: [{ type: 'double', quantity: 1 }],
  bathroomCount: 1,
  maximumGuests: 2,
  amenities: [
    'private garden',
    'fibre Wi-Fi',
    'air conditioning',
    'Smart TV',
    'free street parking',
  ],
  hostNotes: 'A quiet sample property for local verification.',
  operationalNotes: 'PRIVATE SAMPLE MARKER: confirm the guest key is returned on checkout.',
};

export const syntheticHarbourLoftFixture: PropertyConfigurationInput = {
  id: 'harbour-loft-ca',
  name: 'Harbour Loft',
  summary: 'A two-bedroom city loft designed for work trips and longer stays.',
  country: 'CA',
  timezone: 'America/Toronto',
  currency: 'CAD',
  propertyType: 'apartment',
  bedroomCount: 2,
  bedConfiguration: [
    { type: 'queen', quantity: 1 },
    { type: 'single', quantity: 2 },
  ],
  bathroomCount: 2,
  maximumGuests: 4,
  amenities: ['elevator', 'dedicated workspace', 'transit access'],
  hostNotes: 'A dedicated desk and fast Wi-Fi are available for guests.',
  operationalNotes: 'PRIVATE LOFT MARKER: collect the key from the building manager.',
};
