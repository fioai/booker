import type { BedType, PropertyType } from './types.js';

export const PROPERTY_TYPES: ReadonlySet<PropertyType> = new Set([
  'apartment',
  'bungalow',
  'cabin',
  'cottage',
  'house',
  'studio',
  'villa',
]);

export const BED_TYPES: ReadonlySet<BedType> = new Set([
  'bunk',
  'double',
  'king',
  'queen',
  'single',
  'sofa-bed',
]);

export const BED_CAPACITY_BY_TYPE: Readonly<Record<BedType, number>> = Object.freeze({
  bunk: 2,
  double: 2,
  king: 2,
  queen: 2,
  single: 1,
  'sofa-bed': 2,
});
