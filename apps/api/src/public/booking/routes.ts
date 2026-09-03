import { PUBLIC_BOOKING_PATHS_V1 } from '@booking-engine/sdk-typescript';

export type PublicBookingRoute =
  | {
      readonly resource: 'property' | 'availability' | 'quote' | 'requestToBook';
      readonly propertyId: string;
      readonly url: URL;
    }
  | undefined;

export function parsePublicBookingRoute(path: string): PublicBookingRoute {
  let url: URL;
  try {
    url = new URL(path, 'https://booking-engine.invalid');
  } catch {
    return undefined;
  }
  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length < 3 || parts[0] !== 'v1' || parts[1] !== 'properties') {
    return undefined;
  }
  let propertyId: string;
  try {
    propertyId = decodeURIComponent(parts[2] as string);
  } catch {
    return undefined;
  }
  const encodedPropertyId = encodeURIComponent(propertyId);
  const paths = {
    property: PUBLIC_BOOKING_PATHS_V1.property.replace('{propertyId}', encodedPropertyId),
    availability: PUBLIC_BOOKING_PATHS_V1.availability.replace('{propertyId}', encodedPropertyId),
    quote: PUBLIC_BOOKING_PATHS_V1.quote.replace('{propertyId}', encodedPropertyId),
    requestToBook: PUBLIC_BOOKING_PATHS_V1.requestToBook.replace('{propertyId}', encodedPropertyId),
  };
  if (url.pathname === paths.property) {
    return { resource: 'property', propertyId, url };
  }
  if (url.pathname === paths.availability) {
    return { resource: 'availability', propertyId, url };
  }
  if (url.pathname === paths.quote) {
    return { resource: 'quote', propertyId, url };
  }
  if (url.pathname === paths.requestToBook) {
    return { resource: 'requestToBook', propertyId, url };
  }
  return undefined;
}

export function idempotencyKeyHeader(
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key');
  return entry?.[1];
}
