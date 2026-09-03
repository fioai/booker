import type { QuoteBreakdown } from '@booking-engine/booking-core';
import type { BookingRequestRecord } from '@booking-engine/database-postgres';
import type {
  PublicAvailabilityV1,
  PublicQuoteV1,
  PublicRequestToBookV1,
  PublicStayV1,
} from '@booking-engine/sdk-typescript';

export function serializePublicAvailability(
  propertyId: string,
  stay: PublicStayV1,
  available: boolean,
): PublicAvailabilityV1 {
  return Object.freeze({
    propertyId,
    arrival: stay.arrival,
    departure: stay.departure,
    nights: stay.nights,
    available,
  });
}

export function serializePublicQuote(propertyId: string, quote: QuoteBreakdown): PublicQuoteV1 {
  return Object.freeze({
    propertyId,
    arrival: quote.arrival,
    departure: quote.departure,
    nights: quote.nights,
    currency: quote.currency,
    nightly: Object.freeze(
      quote.nightly.map((night) =>
        Object.freeze({ date: night.date, amountMinor: night.amountMinor, source: night.source }),
      ),
    ),
    nightlySubtotalMinor: quote.nightlySubtotalMinor,
    cleaningFeeMinor: quote.cleaningFeeMinor,
    totalMinor: quote.totalMinor,
    minimumStayNights: quote.minimumStayNights,
  });
}

export function serializePublicBookingRequest(
  request: BookingRequestRecord,
): PublicRequestToBookV1 {
  return Object.freeze({
    id: request.id,
    propertyId: request.propertyId,
    arrival: request.arrival,
    departure: request.departure,
    nights: request.quote.nights,
    guestCount: request.guestCount,
    status: request.status,
    quote: serializePublicQuote(request.propertyId, request.quote),
    createdAt: request.createdAt,
  });
}
