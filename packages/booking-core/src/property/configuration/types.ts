declare const propertyConfigurationBrand: unique symbol;

export type PropertyType =
  | 'apartment'
  | 'bungalow'
  | 'cabin'
  | 'cottage'
  | 'house'
  | 'studio'
  | 'villa';

export type BedType = 'bunk' | 'double' | 'king' | 'queen' | 'single' | 'sofa-bed';

export interface BedConfigurationInput {
  readonly type: string;
  readonly quantity: number;
}

/** Untrusted input. Only the factory result is canonical domain state. */
export interface PropertyConfigurationInput {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: string;
  readonly bedroomCount: number;
  readonly bedConfiguration: readonly BedConfigurationInput[];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export interface BedConfiguration {
  readonly type: BedType;
  readonly quantity: number;
}

export interface PropertyConfiguration {
  readonly [propertyConfigurationBrand]: typeof propertyConfigurationBrand;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly country: string;
  readonly timezone: string;
  readonly currency: string;
  readonly propertyType: PropertyType;
  readonly bedroomCount: number;
  readonly bedConfiguration: readonly BedConfiguration[];
  readonly bathroomCount: number;
  readonly maximumGuests: number;
  readonly amenities: readonly string[];
  readonly hostNotes: string;
  readonly operationalNotes: string;
}

export type PropertyConfigurationState = Readonly<{
  id: string;
  name: string;
  summary: string;
  country: string;
  timezone: string;
  currency: string;
  propertyType: PropertyType;
  bedroomCount: number;
  bedConfiguration: readonly BedConfiguration[];
  bathroomCount: number;
  maximumGuests: number;
  amenities: readonly string[];
  hostNotes: string;
  operationalNotes: string;
}>;

export type PropertyValidationErrorCode =
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

export interface PropertyValidationError {
  readonly field: string;
  readonly code: PropertyValidationErrorCode;
  readonly message: string;
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly E[] };

export type PropertyConfigurationResult = Result<PropertyConfiguration, PropertyValidationError>;
