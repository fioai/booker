import type { AdminPageProperty } from '../contracts.js';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

export function renderPropertyPage(input: {
  readonly property: AdminPageProperty;
  readonly csrfToken: string;
}): string {
  const { property, csrfToken } = input;
  const encodedId = encodeURIComponent(property.id);
  const safeId = escapeHtml(property.id);
  const safeCsrf = escapeHtml(csrfToken);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="csrf-token" content="${safeCsrf}"><title>${escapeHtml(property.name)} · Booking Engine admin</title></head><body><main data-admin-property="${safeId}"><h1>${escapeHtml(property.name)}</h1><p>${escapeHtml(property.summary)}</p><section><h2>Guest-visible host notes</h2><p data-public-note>${escapeHtml(property.hostNotes)}</p></section><form method="post" action="/admin/properties/${encodedId}/content"><input type="hidden" name="csrfToken" value="${safeCsrf}"><label>Property name<input name="name" maxlength="120" value="${escapeHtml(property.name)}" required></label><label>Summary<textarea name="summary" maxlength="500" required>${escapeHtml(property.summary)}</textarea></label><label>Private operational notes<textarea name="operationalNotes" maxlength="4000" required>${escapeHtml(property.operationalNotes)}</textarea></label><button type="submit">Save property</button></form><nav><a href="/admin/properties/${encodedId}/rates">Rates</a><a href="/admin/properties/${encodedId}/manual-blocks">Manual blocks</a><a href="/admin/properties/${encodedId}/booking-requests">Booking requests</a></nav></main></body></html>`;
}
