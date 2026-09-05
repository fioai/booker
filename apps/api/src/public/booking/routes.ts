import {
  PUBLIC_BOOKING_PATHS_V1,
  type PublicBookingOperationKeyV1,
} from '@booking-engine/sdk-typescript';

export type PublicBookingRoute =
  | {
      readonly resource: PublicBookingOperationKeyV1;
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
  for (const resource of Object.keys(PUBLIC_BOOKING_PATHS_V1) as PublicBookingOperationKeyV1[]) {
    const path = PUBLIC_BOOKING_PATHS_V1[resource].replace('{propertyId}', encodedPropertyId);
    if (url.pathname === path) {
      return { resource, propertyId, url };
    }
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
