declare const propertyConfigurationBrandV1: unique symbol;

export type PropertyTypeV1 =
  | 'apartment'
  | 'bungalow'
  | 'cabin'
  | 'cottage'
  | 'house'
  | 'studio'
  | 'villa';

export type BedTypeV1 = 'bunk' | 'double' | 'king' | 'queen' | 'single' | 'sofa-bed';

export interface BedConfigurationInputV1 {
  readonly type: string;
  readonly quantity: number;
}

/** Untrusted input. Only the factory result is canonical domain state. */
export interface PropertyConfigurationInputV1 {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: string;
  readonly bedroomCount: number;
  readonly bedConfiguration: readonly BedConfigurationInputV1[];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export interface BedConfigurationV1 {
  readonly type: BedTypeV1;
  readonly quantity: number;
}

export interface PropertyConfigurationV1 {
  readonly [propertyConfigurationBrandV1]: typeof propertyConfigurationBrandV1;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: PropertyTypeV1;
  readonly bedroomCount: number;
  readonly bedConfiguration: readonly BedConfigurationV1[];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export type PropertyConfigurationStateV1 = Readonly<{
  id: string;
  name: string;
  summary: string;
  country: string;
  timezone: string;
  currency: string;
  propertyType: PropertyTypeV1;
  bedroomCount: number;
  bedConfiguration: readonly BedConfigurationV1[];
  bathroomCount: number;
  maximumGuests: number;
  amenities: readonly string[];
  hostNotes: string;
  operationalNotes: string;
}>;

export type PropertyValidationErrorCodeV1 =
  | 'invalid_input'
  | 'missing_field'
  | 'invalid_string'
  | 'empty_string'
  | 'string_too_long'
  | 'malformed_id'
  | 'malformed_country'
  | 'unsupported_country'
  | 'malformed_currency'
  | 'unsupported_currency'
  | 'malformed_timezone'
  | 'unsupported_timezone'
  | 'unsupported_property_type'
  | 'invalid_count'
  | 'negative_count'
  | 'count_too_large'
  | 'invalid_array'
  | 'empty_array'
  | 'array_too_long'
  | 'malformed_string'
  | 'unknown_field'
  | 'unsupported_bed_type'
  | 'duplicate_bed_type'
  | 'impossible_configuration'
  | 'exceeds_bed_capacity'
  | 'duplicate_amenity';

export interface PropertyValidationErrorV1 {
  readonly field: string;
  readonly code: PropertyValidationErrorCodeV1;
  readonly message: string;
}

export type ResultV1<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly E[] };

export type PropertyConfigurationResultV1 = ResultV1<
  PropertyConfigurationV1,
  PropertyValidationErrorV1
>;
