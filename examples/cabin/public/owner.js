/* global document, fetch, FormData */

import { element, feedback, money, propertyId, stayLabel } from './shared.js';

const basePath = `/admin/properties/${propertyId}/booking-requests`;
const loginForm = element('login-form');

async function admin(path, body) {
  const csrf = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('booking_engine_admin_csrf='))
    ?.split('=')[1];
  const response = await fetch(path, {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? { Accept: 'application/json' }
        : {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf ?? '',
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const error = new Error(result?.error?.message ?? 'The owner request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function showLogin() {
  element('inbox').hidden = true;
  element('request-list').replaceChildren();
  element('login-panel').hidden = false;
  // Obtain the double-submit CSRF cookie without exposing session tokens to JavaScript.
  const response = await fetch('/admin/login', { credentials: 'same-origin' });
  if (!response.ok)
    throw new Error('Could not start sign-in. Check that the local API is running.');
}

function renderRequests(requests) {
  const cards = requests.map((request) => {
    const card = element('request-template').content.firstElementChild.cloneNode(true);
    const set = (selector, value) => {
      card.querySelector(selector).textContent = value;
    };
    set('.status', request.status);
    card.querySelector('.status').dataset.status = request.status;
    set('.guest-name', request.guestName);
    set(
      '.stay',
      `${stayLabel(request.arrival, request.departure)} · ${request.guestCount} guest${request.guestCount === 1 ? '' : 's'}`,
    );
    set('.guest-email', request.guestEmail);
    set('.guest-note', request.message ?? '');
    set('.reference', `Ref ${request.id}`);
    set('.request-total', money(request.quote.totalMinor, request.quote.currency));
    for (const action of ['approve', 'reject']) {
      const button = card.querySelector(`.${action}`);
      button.hidden = request.status !== 'pending';
      button.addEventListener('click', () => {
        void decide(request.id, action, card);
      });
    }
    return card;
  });
  element('request-list').replaceChildren(...cards);
  element('empty-inbox').hidden = requests.length > 0;
}

async function refreshInbox() {
  const result = await admin(basePath);
  renderRequests(result.requests);
  element('login-panel').hidden = true;
  element('inbox').hidden = false;
}

async function handleError(error, target = element('owner-message')) {
  if (error.status === 401) {
    await showLogin().catch(() => {});
    feedback(element('owner-message'), 'Your session ended. Sign in again to continue.', true);
  } else {
    feedback(target, error.message, true);
  }
}

async function decide(id, action, card) {
  const buttons = card.querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  const message = card.querySelector('.feedback');
  feedback(message, action === 'approve' ? 'Rechecking availability…' : 'Saving the decision…');
  try {
    const path = `${basePath}/${encodeURIComponent(id)}`;
    if (action === 'approve') {
      const check = await admin(`${path}/recheck`, {});
      if (check.request.status !== 'pending' || check.available !== true) {
        await refreshInbox();
        feedback(
          element('owner-message'),
          `Approval stopped. Status: ${check.request.status}; dates ${check.available ? 'available' : 'unavailable'}.`,
          true,
        );
        return;
      }
    }
    const decision = await admin(`${path}/${action}`, {});
    const saved = await admin(path);
    await refreshInbox();
    const expected = action === 'approve' ? 'approved' : 'rejected';
    feedback(
      element('owner-message'),
      `Persisted decision: ${saved.status}. ${saved.status === 'approved' ? 'These dates are now blocked.' : 'No email was sent.'}`,
      decision.status !== expected || saved.status !== expected,
    );
  } catch (error) {
    await handleError(error, message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  element('sign-in').disabled = true;
  feedback(element('owner-message'), 'Signing in…');
  try {
    const data = new FormData(loginForm);
    await admin('/admin/login', { email: data.get('email'), password: data.get('password') });
    loginForm.elements.password.value = '';
    await admin('/admin/session');
    await refreshInbox();
    feedback(element('owner-message'), '');
  } catch (error) {
    await handleError(error);
  } finally {
    element('sign-in').disabled = false;
  }
});

element('sample-owner').addEventListener('click', () => {
  loginForm.elements.email.value = 'sample-owner@example.test';
  loginForm.elements.password.value = 'local-only-owner-password';
});

element('refresh-inbox').addEventListener('click', async () => {
  element('refresh-inbox').disabled = true;
  try {
    await refreshInbox();
    feedback(element('owner-message'), 'Inbox refreshed.');
  } catch (error) {
    await handleError(error);
  } finally {
    element('refresh-inbox').disabled = false;
  }
});

element('sign-out').addEventListener('click', async () => {
  element('sign-out').disabled = true;
  try {
    await admin('/admin/logout', {});
    await showLogin();
    feedback(element('owner-message'), 'Signed out.');
  } catch (error) {
    await handleError(error);
  } finally {
    element('sign-out').disabled = false;
  }
});

async function start() {
  try {
    await admin('/admin/session');
    await refreshInbox();
    feedback(element('owner-message'), '');
  } catch (error) {
    if (error.status === 401) {
      try {
        await showLogin();
        feedback(element('owner-message'), '');
      } catch (loginError) {
        await handleError(loginError);
      }
    } else {
      await handleError(error);
    }
  }
}
void start();
