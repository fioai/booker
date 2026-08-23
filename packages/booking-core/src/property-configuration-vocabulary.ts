import type { BedTypeV1, PropertyTypeV1 } from './property-configuration-types.js';

export const PROPERTY_TYPES_V1: ReadonlySet<PropertyTypeV1> = new Set([
  'apartment',
  'bungalow',
  'cabin',
  'cottage',
  'house',
  'studio',
  'villa',
]);

export const BED_TYPES_V1: ReadonlySet<BedTypeV1> = new Set([
  'bunk',
  'double',
  'king',
  'queen',
  'single',
  'sofa-bed',
]);

export const BED_CAPACITY_BY_TYPE_V1: Readonly<Record<BedTypeV1, number>> = Object.freeze({
  bunk: 2,
  double: 2,
  king: 2,
  queen: 2,
  single: 1,
  'sofa-bed': 2,
});
