import type {
  PropertyConfigurationResult,
  PropertyConfigurationState,
  PropertyConfiguration,
} from './types.js';
import { freezePropertyConfigurationState, parsePropertyConfiguration } from './parser.js';

const constructionToken = Symbol('PropertyConfiguration construction token');
const canonicalInstances = new WeakSet<object>();
const stateByInstance = new WeakMap<object, PropertyConfigurationState>();

function readCanonicalState(instance: object): PropertyConfigurationState {
  const state = stateByInstance.get(instance);
  if (state === undefined) {
    throw new TypeError('PropertyConfiguration instance is not canonical.');
  }

  return state;
}

/** Module-private implementation; callers receive only the branded interface. */
class CanonicalPropertyConfiguration {
  constructor(state: PropertyConfigurationState, token: symbol) {
    if (token !== constructionToken) {
      throw new TypeError('PropertyConfiguration instances can only be created by the factory.');
    }

    stateByInstance.set(this, state);
    canonicalInstances.add(this);
    Object.freeze(this);
  }

  get id(): string {
    return readCanonicalState(this).id;
  }

  get name(): string {
    return readCanonicalState(this).name;
  }

  get summary(): string {
    return readCanonicalState(this).summary;
  }

  get country(): string {
    return readCanonicalState(this).country;
  }

  get timezone(): string {
    return readCanonicalState(this).timezone;
  }

  get currency(): string {
    return readCanonicalState(this).currency;
  }

  get propertyType(): PropertyConfigurationState['propertyType'] {
    return readCanonicalState(this).propertyType;
  }

  get bedroomCount(): number {
    return readCanonicalState(this).bedroomCount;
  }

  get bedConfiguration(): PropertyConfigurationState['bedConfiguration'] {
    return readCanonicalState(this).bedConfiguration;
  }

  get bathroomCount(): number {
    return readCanonicalState(this).bathroomCount;
  }

  get maximumGuests(): number {
    return readCanonicalState(this).maximumGuests;
  }

  get amenities(): PropertyConfigurationState['amenities'] {
    return readCanonicalState(this).amenities;
  }

  get hostNotes(): string {
    return readCanonicalState(this).hostNotes;
  }

  get operationalNotes(): string {
    return readCanonicalState(this).operationalNotes;
  }
}

Object.freeze(CanonicalPropertyConfiguration.prototype);

export function isPropertyConfiguration(value: unknown): value is PropertyConfiguration {
  return typeof value === 'object' && value !== null && canonicalInstances.has(value);
}

export function createPropertyConfiguration(input: unknown): PropertyConfigurationResult {
  const parsed = parsePropertyConfiguration(input);
  if (!parsed.ok) {
    return parsed;
  }

  const state = freezePropertyConfigurationState(parsed.value);
  const implementation = new CanonicalPropertyConfiguration(state, constructionToken);
  return { ok: true, value: implementation as unknown as PropertyConfiguration };
}
