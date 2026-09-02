export const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const MAX_ROUTE_SEGMENTS = 8;
export const MAX_ROUTE_LENGTH = 8_192;

export type AdminRoute =
  | { readonly kind: 'login' }
  | { readonly kind: 'logout' }
  | { readonly kind: 'session' }
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'property'; readonly propertyId: string; readonly page: boolean }
  | { readonly kind: 'content'; readonly propertyId: string }
  | { readonly kind: 'rates'; readonly propertyId: string }
  | { readonly kind: 'manualBlocks'; readonly propertyId: string }
  | { readonly kind: 'bookingRequests'; readonly propertyId: string }
  | {
      readonly kind: 'manualBlock';
      readonly propertyId: string;
      readonly recordId: string;
    }
  | {
      readonly kind: 'icalHealth';
      readonly propertyId: string;
      readonly sourceId: string;
    }
  | {
      readonly kind: 'bookingRequest';
      readonly propertyId: string;
      readonly requestId: string;
      readonly action: 'get' | 'approve' | 'reject' | 'recheck';
    };

export function parseAdminRoute(path: string): AdminRoute | undefined {
  if (typeof path !== 'string' || path.length > MAX_ROUTE_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(path, 'https://booking-engine.invalid');
  } catch {
    return undefined;
  }
  const parts = url.pathname.split('/');
  if (parts.some((part, index) => index > 0 && part.length === 0)) {
    return undefined;
  }
  const nonEmptyParts = parts.filter((part) => part.length > 0);
  if (
    nonEmptyParts.length === 0 ||
    nonEmptyParts[0] !== 'admin' ||
    nonEmptyParts.length > MAX_ROUTE_SEGMENTS
  ) {
    return undefined;
  }
  const decoded: string[] = [];
  try {
    for (const part of nonEmptyParts) {
      const value = decodeURIComponent(part);
      if (value.length > 512) {
        return undefined;
      }
      decoded.push(value);
    }
  } catch {
    return undefined;
  }
  if (decoded.length === 2 && decoded[1] === 'login') {
    return { kind: 'login' };
  }
  if (decoded.length === 2 && decoded[1] === 'logout') {
    return { kind: 'logout' };
  }
  if (decoded.length === 2 && decoded[1] === 'session') {
    return { kind: 'session' };
  }
  if (decoded.length === 1) {
    return { kind: 'dashboard' };
  }
  if (decoded.length < 3 || decoded[1] !== 'properties') {
    return undefined;
  }
  const propertyId = decoded[2];
  if (propertyId === undefined) {
    return undefined;
  }
  if (decoded.length === 3) {
    return { kind: 'property', propertyId, page: false };
  }
  if (decoded.length === 4 && decoded[3] === 'page') {
    return { kind: 'property', propertyId, page: true };
  }
  if (decoded.length === 4 && (decoded[3] === 'content' || decoded[3] === 'notes')) {
    return { kind: 'content', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'rates') {
    return { kind: 'rates', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'manual-blocks') {
    return { kind: 'manualBlocks', propertyId };
  }
  if (decoded.length === 4 && decoded[3] === 'booking-requests') {
    return { kind: 'bookingRequests', propertyId };
  }
  if (decoded.length === 5 && decoded[3] === 'manual-blocks' && decoded[4] !== undefined) {
    return { kind: 'manualBlock', propertyId, recordId: decoded[4] };
  }
  if (
    decoded.length === 6 &&
    (decoded[3] === 'ical' || decoded[3] === 'ical-sources' || decoded[3] === 'ical-sync') &&
    decoded[5] === 'health' &&
    decoded[4] !== undefined
  ) {
    return { kind: 'icalHealth', propertyId, sourceId: decoded[4] };
  }
  if (
    decoded.length === 6 &&
    decoded[3] === 'booking-requests' &&
    decoded[4] !== undefined &&
    decoded[5] !== undefined
  ) {
    const action = decoded[5];
    if (action === 'approve' || action === 'reject') {
      return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action };
    }
    if (action === 'recheck' || action === 'recheck-availability') {
      return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action: 'recheck' };
    }
  }
  if (decoded.length === 5 && decoded[3] === 'booking-requests' && decoded[4] !== undefined) {
    return { kind: 'bookingRequest', propertyId, requestId: decoded[4], action: 'get' };
  }
  return undefined;
}
