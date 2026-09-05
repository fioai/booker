/* global document */

export const propertyId = 'sample-bungalow';
export const element = (id) => document.getElementById(id);
export const money = (amountMinor, currency) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(amountMinor / 100);
export const stayLabel = (arrival, departure) => {
  const format = (date) =>
    new Intl.DateTimeFormat('en-CA', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T12:00:00Z`));
  return `${format(arrival)} – ${format(departure)}`;
};
export function feedback(target, message, error = false) {
  target.textContent = message;
  target.dataset.error = String(error);
}
