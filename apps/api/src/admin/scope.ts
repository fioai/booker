import type { PropertyConfiguration } from '@booking-engine/booking-core';
import type { BookingRequestRecord, OrganizationScope } from '@booking-engine/database-postgres';

import type { AdminSession } from './auth.js';
import { AdminHttpError, type AdminHttpApiDependencies } from './contracts.js';
import { mapPersistenceError, notFound } from './serialization.js';
import { canonicalProperty, validIdentifier } from './validation.js';

export function scopeFor(session: AdminSession): OrganizationScope {
  return Object.freeze({ organizationId: session.organizationId });
}

export async function loadProperty(
  dependencies: AdminHttpApiDependencies,
  session: AdminSession,
  propertyId: string,
): Promise<PropertyConfiguration> {
  const id = validIdentifier(propertyId, 'propertyId');
  try {
    const property = await dependencies.properties.findById(scopeFor(session), id);
    if (property === null || property.id !== id) {
      notFound();
    }
    return canonicalProperty(property);
  } catch (error) {
    if (error instanceof AdminHttpError) {
      throw error;
    }
    throw mapPersistenceError(error);
  }
}

export function scopedBookingRequest(
  request: BookingRequestRecord | null,
  session: AdminSession,
  propertyId: string,
  requestId: string,
): BookingRequestRecord {
  if (
    request === null ||
    request.id !== requestId ||
    request.propertyId !== propertyId ||
    request.organizationId !== session.organizationId
  ) {
    notFound();
  }
  return request;
}
