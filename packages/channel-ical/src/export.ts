import { TextEncoder } from 'node:util';

export const ICAL_EXPORT_LIMITS = Object.freeze({
  maxReservations: 1_000,
  maxUidLength: 512,
  maxTextLength: 2_000,
  maxNights: 3_660,
});

export interface ICalExportReservation {
  readonly uid: string;
  readonly summary: string;
  readonly arrival: string;
  readonly departure: string;
  readonly updatedAt?: string | Date;
}

export interface ICalExportInput {
  readonly calendarName?: string;
  readonly prodId?: string;
  readonly reservations: readonly ICalExportReservation[];
}

const textEncoder = new TextEncoder();

function dayNumber(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const current = dayNumber(year, month, day);
  return current >= dayNumber(year, month, 1) && current < dayNumber(nextYear, nextMonth, 1);
}

function nights(arrival: string, departure: string): number {
  return (
    dayNumber(
      Number(departure.slice(0, 4)),
      Number(departure.slice(5, 7)),
      Number(departure.slice(8, 10)),
    ) -
    dayNumber(
      Number(arrival.slice(0, 4)),
      Number(arrival.slice(5, 7)),
      Number(arrival.slice(8, 10)),
    )
  );
}

function safeText(value: string, field: string): string {
  let normalized = '';
  let previousWasSpace = false;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    const unsafe =
      code === 0 ||
      (code >= 1 && code <= 8) ||
      code === 10 ||
      code === 11 ||
      code === 12 ||
      code === 13 ||
      (code >= 14 && code <= 31) ||
      code === 127;
    if (unsafe || (code >= 127 && code <= 159)) {
      if (!previousWasSpace) {
        normalized += ' ';
      }
      previousWasSpace = true;
    } else {
      normalized += character;
      previousWasSpace = character === ' ';
    }
  }
  normalized = normalized.trim();
  if (normalized.length === 0 || normalized.length > ICAL_EXPORT_LIMITS.maxTextLength) {
    throw new TypeError(`${field} must be a bounded non-empty text value.`);
  }
  return normalized;
}

function escapeText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,');
}

function formatDate(value: string, field: string): string {
  if (!validDate(value)) {
    throw new TypeError(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return value.replaceAll('-', '');
}

function formatTimestamp(value: string | Date | undefined): string {
  let date: Date;
  if (typeof value === 'string') {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):?(\d{2}))$/u.exec(
        value,
      );
    if (match === null) {
      throw new TypeError(
        'updatedAt string must be a valid timestamp with an explicit UTC or numeric offset.',
      );
    }
    const [
      ,
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
      secondText,
      fractionText,
      offsetText,
      offsetHourText,
      offsetMinuteText,
    ] = match;
    if (
      yearText === undefined ||
      monthText === undefined ||
      dayText === undefined ||
      hourText === undefined ||
      minuteText === undefined ||
      secondText === undefined ||
      offsetText === undefined
    ) {
      throw new TypeError('updatedAt must be a valid timestamp.');
    }
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
    const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
    if (
      !validDate(`${yearText}-${monthText}-${dayText}`) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      throw new TypeError('updatedAt must be a valid timestamp.');
    }
    const fraction =
      fractionText === undefined ? '' : `.${fractionText.slice(0, 3).padEnd(3, '0')}`;
    const offset =
      offsetText === 'Z' || offsetText.includes(':')
        ? offsetText
        : `${offsetText.slice(0, 3)}:${offsetText.slice(3)}`;
    date = new Date(
      `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${fraction}${offset}`,
    );
  } else {
    date = value === undefined ? new Date(0) : new Date(value);
  }
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new TypeError('updatedAt must be a valid timestamp.');
  }
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function foldLine(line: string): readonly string[] {
  const lines: string[] = [];
  let current = '';
  for (const character of line) {
    const candidate = current + character;
    if (current.length > 0 && textEncoder.encode(candidate).byteLength > 75) {
      lines.push(current);
      current = ` ${character}`;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function validateReservation(reservation: ICalExportReservation): void {
  if (
    typeof reservation.uid !== 'string' ||
    reservation.uid.trim().length === 0 ||
    reservation.uid !== reservation.uid.trim() ||
    reservation.uid.length > ICAL_EXPORT_LIMITS.maxUidLength ||
    hasUnsafeControlCharacters(reservation.uid)
  ) {
    throw new TypeError('reservation uid is invalid.');
  }
  safeText(reservation.summary, 'reservation summary');
  if (!validDate(reservation.arrival) || !validDate(reservation.departure)) {
    throw new TypeError('reservation arrival and departure must be valid dates.');
  }
  const stayNights = nights(reservation.arrival, reservation.departure);
  if (stayNights <= 0 || stayNights > ICAL_EXPORT_LIMITS.maxNights) {
    throw new TypeError('reservation departure must be after arrival within the supported bound.');
  }
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code === 0 || code <= 31 || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

export function exportICalCalendar(input: ICalExportInput): string {
  if (
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(input.reservations) ||
    input.reservations.length > ICAL_EXPORT_LIMITS.maxReservations
  ) {
    throw new TypeError('reservations must be a bounded array.');
  }
  const name =
    input.calendarName === undefined
      ? 'Booking Engine direct reservations'
      : safeText(input.calendarName, 'calendarName');
  const prodId =
    input.prodId === undefined
      ? '-//Booking Engine//iCal 1.0//EN'
      : safeText(input.prodId, 'prodId');
  const seenUids = new Set<string>();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];

  for (const reservation of input.reservations) {
    validateReservation(reservation);
    if (seenUids.has(reservation.uid)) {
      throw new TypeError('reservation UIDs must be unique.');
    }
    seenUids.add(reservation.uid);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeText(reservation.uid)}`);
    lines.push(`DTSTAMP:${formatTimestamp(reservation.updatedAt)}`);
    lines.push(`DTSTART;VALUE=DATE:${formatDate(reservation.arrival, 'arrival')}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(reservation.departure, 'departure')}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('SEQUENCE:0');
    lines.push(`SUMMARY:${escapeText(safeText(reservation.summary, 'reservation summary'))}`);
    lines.push(`LAST-MODIFIED:${formatTimestamp(reservation.updatedAt)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.flatMap(foldLine).join('\r\n')}\r\n`;
}
