import type {
  PropertyConfigurationResultV1,
  PropertyConfigurationStateV1,
  PropertyConfigurationV1,
} from './property-configuration-types.js';
import {
  freezePropertyConfigurationStateV1,
  parsePropertyConfigurationV1,
} from './property-configuration-parser.js';

const constructionTokenV1 = Symbol('PropertyConfigurationV1 construction token');
const canonicalInstancesV1 = new WeakSet<object>();
const stateByInstanceV1 = new WeakMap<object, PropertyConfigurationStateV1>();

function readCanonicalStateV1(instance: object): PropertyConfigurationStateV1 {
  const state = stateByInstanceV1.get(instance);
  if (state === undefined) {
    throw new TypeError('PropertyConfigurationV1 instance is not canonical.');
  }

  return state;
}

/** Module-private implementation; callers receive only the branded interface. */
class CanonicalPropertyConfigurationV1 {
  constructor(state: PropertyConfigurationStateV1, token: symbol) {
    if (token !== constructionTokenV1) {
      throw new TypeError('PropertyConfigurationV1 instances can only be created by the factory.');
    }

    stateByInstanceV1.set(this, state);
    canonicalInstancesV1.add(this);
    Object.freeze(this);
  }

  get id(): string {
    return readCanonicalStateV1(this).id;
  }

  get name(): string {
    return readCanonicalStateV1(this).name;
  }

  get summary(): string {
    return readCanonicalStateV1(this).summary;
  }

  get country(): string {
    return readCanonicalStateV1(this).country;
  }

  get timezone(): string {
    return readCanonicalStateV1(this).timezone;
  }

  get currency(): string {
    return readCanonicalStateV1(this).currency;
  }

  get propertyType(): PropertyConfigurationStateV1['propertyType'] {
    return readCanonicalStateV1(this).propertyType;
  }

  get bedroomCount(): number {
    return readCanonicalStateV1(this).bedroomCount;
  }

  get bedConfiguration(): PropertyConfigurationStateV1['bedConfiguration'] {
    return readCanonicalStateV1(this).bedConfiguration;
  }

  get bathroomCount(): number {
    return readCanonicalStateV1(this).bathroomCount;
  }

  get maximumGuests(): number {
    return readCanonicalStateV1(this).maximumGuests;
  }

  get amenities(): PropertyConfigurationStateV1['amenities'] {
    return readCanonicalStateV1(this).amenities;
  }

  get hostNotes(): string {
    return readCanonicalStateV1(this).hostNotes;
  }

  get operationalNotes(): string {
    return readCanonicalStateV1(this).operationalNotes;
  }
}

Object.freeze(CanonicalPropertyConfigurationV1.prototype);

export function isPropertyConfigurationV1(value: unknown): value is PropertyConfigurationV1 {
  return typeof value === 'object' && value !== null && canonicalInstancesV1.has(value);
}

export function createPropertyConfigurationV1(input: unknown): PropertyConfigurationResultV1 {
  const parsed = parsePropertyConfigurationV1(input);
  if (!parsed.ok) {
    return parsed;
  }

  const state = freezePropertyConfigurationStateV1(parsed.value);
  const implementation = new CanonicalPropertyConfigurationV1(state, constructionTokenV1);
  return { ok: true, value: implementation as unknown as PropertyConfigurationV1 };
}
