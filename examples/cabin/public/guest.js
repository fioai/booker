/* global document, window, crypto, FormData */

import { createBookingEngineClientV1, PUBLIC_BOOKING_LIMITS_V1 } from '/sdk/index.js';
import { element, feedback, money, propertyId, stayLabel } from './shared.js';

const client = createBookingEngineClientV1({
  baseUrl: window.location.origin,
  defaultPropertyId: propertyId,
});
const datesForm = element('dates-form');
const guestForm = element('guest-form');
const arrival = element('arrival');
const departure = element('departure');
let quote;
let dateRevision = 0;
let attempt;

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clearQuote() {
  dateRevision += 1;
  quote = undefined;
  element('quote').hidden = true;
  guestForm.hidden = true;
  feedback(element('availability-message'), '');
  feedback(element('request-message'), '');
}

datesForm.addEventListener('input', () => {
  clearQuote();
  if (arrival.value) {
    departure.min = addDays(arrival.value, 1);
    if (departure.value <= arrival.value) departure.value = addDays(arrival.value, 2);
  }
});

datesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearQuote();
  const revision = dateRevision;
  const stay = { arrival: arrival.value, departure: departure.value };
  element('check-dates').disabled = true;
  feedback(element('availability-message'), 'Checking your dates…');
  try {
    const [availability, result] = await Promise.all([
      client.getAvailability(propertyId, stay),
      client.getQuote(propertyId, stay),
    ]);
    if (revision !== dateRevision) return;
    if (!availability.available) {
      feedback(
        element('availability-message'),
        'These dates are unavailable. Try another stay.',
        true,
      );
      return;
    }
    quote = result;
    element('night-label').textContent = `${quote.nights} night${quote.nights === 1 ? '' : 's'}`;
    element('night-total').textContent = money(quote.nightlySubtotalMinor, quote.currency);
    element('cleaning-total').textContent = money(quote.cleaningFeeMinor, quote.currency);
    element('quote-total').textContent = money(quote.totalMinor, quote.currency);
    element('currency').textContent = quote.currency;
    element('quote').hidden = false;
    guestForm.hidden = false;
    feedback(element('availability-message'), 'Your dates are available to request.');
  } catch (error) {
    if (revision === dateRevision) feedback(element('availability-message'), error.message, true);
  } finally {
    element('check-dates').disabled = false;
  }
});

function showRequest(request) {
  datesForm.hidden = true;
  guestForm.hidden = true;
  element('quote').hidden = true;
  element('request-result').hidden = false;
  feedback(element('availability-message'), '');
  const status = element('request-status');
  status.textContent = request.status;
  status.dataset.status = request.status;
  const messages = {
    pending: [
      'Your request is with the host.',
      'Your dates are not reserved yet. Open the owner inbox to review and approve this sample stay.',
    ],
    approved: [
      'Your stay is approved.',
      'These dates are now blocked for other stays. No payment has been collected.',
    ],
    rejected: [
      'This request was declined.',
      'Your dates were not reserved. You can start another request.',
    ],
    expired: [
      'This request has expired.',
      'Your dates were not reserved. Start a new request to check availability again.',
    ],
  };
  const [title, description] = messages[request.status] ?? [
    'Request updated.',
    `Current status: ${request.status}.`,
  ];
  element('request-title').textContent = title;
  element('request-description').textContent = description;
  element('request-reference').textContent =
    `${stayLabel(request.arrival, request.departure)} · ${money(request.quote.totalMinor, request.quote.currency)} · Ref ${request.id}`;
}

guestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!quote || quote.arrival !== arrival.value || quote.departure !== departure.value) return;
  const data = new FormData(guestForm);
  const input = {
    arrival: quote.arrival,
    departure: quote.departure,
    guestCount: Number(data.get('guestCount')),
    guestName: data.get('guestName').trim(),
    guestEmail: data.get('guestEmail').trim(),
    ...(data.get('message').trim() ? { message: data.get('message').trim() } : {}),
  };
  const fingerprint = JSON.stringify(input);
  // A transport failure may happen after persistence. Retry the same input with the same key.
  if (attempt?.fingerprint !== fingerprint) {
    attempt = { input, fingerprint, idempotencyKey: crypto.randomUUID() };
  }
  element('send-request').disabled = true;
  feedback(element('request-message'), 'Sending your request…');
  try {
    const request = await client.requestToBook(propertyId, attempt.input, attempt);
    showRequest(request);
    feedback(element('request-message'), '');
    element('request-title').focus();
  } catch (error) {
    feedback(element('request-message'), `${error.message} You can retry this request.`, true);
  } finally {
    element('send-request').disabled = false;
  }
});

element('refresh-status').addEventListener('click', async () => {
  const currentAttempt = attempt;
  element('refresh-status').disabled = true;
  try {
    // V1 idempotent replay returns the persisted lifecycle; there is no public lookup endpoint.
    const request = await client.requestToBook(propertyId, currentAttempt.input, currentAttempt);
    if (attempt !== currentAttempt) return;
    showRequest(request);
    feedback(element('request-message'), 'Decision refreshed.');
  } catch (error) {
    if (attempt === currentAttempt) feedback(element('request-message'), error.message, true);
  } finally {
    element('refresh-status').disabled = false;
  }
});

element('another-stay').addEventListener('click', () => {
  attempt = undefined;
  guestForm.reset();
  clearQuote();
  element('request-result').hidden = true;
  datesForm.hidden = false;
  arrival.focus();
});

element('sample-guest').addEventListener('click', () => {
  guestForm.elements.guestName.value = 'Alex Morgan';
  guestForm.elements.guestEmail.value = 'alex@example.test';
  guestForm.elements.message.value = 'We expect to arrive in the afternoon.';
});

async function start() {
  element('check-dates').disabled = true;
  try {
    const property = await client.getPublicProperty();
    document.title = `${property.name} · Booking Engine example`;
    element('property-title').textContent = property.name;
    element('property-summary').textContent = property.summary;
    element('host-notes').textContent = property.hostNotes;
    guestForm.elements.guestCount.replaceChildren(
      ...Array.from({ length: property.maximumGuests }, (_, index) => {
        const option = document.createElement('option');
        const count = index + 1;
        option.value = String(count);
        option.textContent = `${count} guest${count === 1 ? '' : 's'}`;
        option.defaultSelected = count === Math.min(2, property.maximumGuests);
        return option;
      }),
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: property.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    arrival.min = today;
    arrival.value = addDays(today, 14);
    departure.value = addDays(arrival.value, 2);
    departure.min = addDays(arrival.value, 1);
    guestForm.elements.guestName.maxLength = PUBLIC_BOOKING_LIMITS_V1.maximumGuestNameLength;
    guestForm.elements.message.maxLength = PUBLIC_BOOKING_LIMITS_V1.maximumMessageLength;
    element('check-dates').disabled = false;
  } catch {
    element('property-summary').textContent = 'Property details could not be loaded.';
    feedback(
      element('availability-message'),
      'The sample property is unavailable. Start the seeded Compose app, then reload this page.',
      true,
    );
  }
}
void start();
