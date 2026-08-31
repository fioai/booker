import { TextDecoder, TextEncoder } from 'node:util';
import { ICAL_SEQUENCE_MAX } from './protocol-limits.js';

export const ICAL_PARSE_LIMITS = Object.freeze({
  maxBytes: 1_000_000,
  maxEvents: 500,
  maxLineLength: 8_192,
  maxUidLength: 512,
  maxTextLength: 2_000,
  maxNights: 3_660,
});

export type ICalParseErrorCode =
  | 'invalid_input'
  | 'invalid_encoding'
  | 'body_limit'
  | 'line_too_long'
  | 'invalid_line'
  | 'missing_calendar'
  | 'invalid_component'
  | 'missing_event'
  | 'event_limit'
  | 'missing_property'
  | 'duplicate_property'
  | 'duplicate_uid'
  | 'invalid_uid'
  | 'invalid_date'
  | 'ambiguous_timezone'
  | 'invalid_interval'
  | 'invalid_sequence'
  | 'invalid_timestamp'
  | 'invalid_status'
  | 'invalid_transparency'
  | 'unsupported_recurrence'
  | 'text_too_long';

export class ICalParseError extends Error {
  readonly code: ICalParseErrorCode;
  readonly line: number | null;

  constructor(code: ICalParseErrorCode, message: string, line: number | null = null) {
    super(message);
    this.name = 'ICalParseError';
    this.code = code;
    this.line = line;
  }
}

export type ICalEventStatus = 'confirmed' | 'tentative' | 'cancelled' | 'unknown';

export interface ICalEvent {
  readonly uid: string;
  readonly arrival: string;
  readonly departure: string;
  readonly status: ICalEventStatus;
  readonly sequence: number | null;
  readonly lastModified: string | null;
  readonly summary: string | null;
}

export interface ICalCalendar {
  readonly prodId: string | null;
  readonly events: readonly ICalEvent[];
}

export interface ICalParseOptions {
  readonly maxBytes?: number;
  readonly maxEvents?: number;
  readonly maxLineLength?: number;
}

interface RawProperty {
  readonly name: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly value: string;
  readonly line: number;
}

interface RawEvent {
  readonly properties: Map<string, RawProperty>;
  readonly line: number;
}

const UNIQUE_EVENT_PROPERTIES: Readonly<Record<string, true>> = Object.freeze({
  UID: true,
  DTSTART: true,
  DTEND: true,
  STATUS: true,
  TRANSP: true,
  SEQUENCE: true,
  'LAST-MODIFIED': true,
  SUMMARY: true,
});

const RECURRENCE_PROPERTIES: Readonly<Record<string, true>> = Object.freeze({
  RRULE: true,
  RDATE: true,
  EXDATE: true,
  EXRULE: true,
  'RECURRENCE-ID': true,
});

const textEncoder = new TextEncoder();

function parseLimit(value: number | undefined, fallback: number, name: string): number {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1 || value > fallback * 100)
  ) {
    throw new RangeError(`${name} must be a positive bounded integer.`);
  }
  return value ?? fallback;
}

function decodeInput(input: string | Uint8Array, maxBytes: number): string {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    throw new ICalParseError('invalid_input', 'iCalendar input must be text or UTF-8 bytes.');
  }
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input;
  if (bytes.byteLength > maxBytes) {
    throw new ICalParseError('body_limit', 'iCalendar body exceeds the configured limit.');
  }

  if (typeof input === 'string') {
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input);
    return decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  } catch {
    throw new ICalParseError('invalid_encoding', 'iCalendar body is not valid UTF-8.');
  }
}

function unfoldLines(input: string, maxLineLength: number): readonly string[] {
  if (input.includes('\u0000') || /\r(?!\n)/u.test(input)) {
    throw new ICalParseError('invalid_line', 'iCalendar contains an invalid line ending.');
  }

  const physicalLines = input.replaceAll('\r\n', '\n').split('\n');
  if (physicalLines.at(-1) === '') {
    physicalLines.pop();
  }

  const unfolded: Array<{ fragments: string[]; byteLength: number }> = [];
  for (const physicalLine of physicalLines) {
    const physicalByteLength = textEncoder.encode(physicalLine).byteLength;
    if (physicalByteLength > maxLineLength) {
      throw new ICalParseError('line_too_long', 'iCalendar contains an oversized line.');
    }
    if (physicalLine.startsWith(' ') || physicalLine.startsWith('\t')) {
      const previous = unfolded.at(-1);
      if (previous === undefined) {
        throw new ICalParseError('invalid_line', 'iCalendar begins with a continuation line.');
      }
      // The fold marker is one ASCII byte and is not part of the unfolded value.
      previous.byteLength += physicalByteLength - 1;
      if (previous.byteLength > maxLineLength) {
        throw new ICalParseError('line_too_long', 'iCalendar contains an oversized unfolded line.');
      }
      previous.fragments.push(physicalLine.slice(1));
      continue;
    }
    if (physicalLine.length === 0) {
      throw new ICalParseError('invalid_line', 'iCalendar contains an empty line.');
    }
    unfolded.push({ fragments: [physicalLine], byteLength: physicalByteLength });
  }
  return unfolded.map(({ fragments }) => fragments.join(''));
}

function splitParameters(value: string): readonly string[] {
  const pieces: string[] = [];
  let quoted = false;
  let current = '';
  for (const character of value) {
    if (character === '"') {
      quoted = !quoted;
      current += character;
    } else if (character === ';' && !quoted) {
      pieces.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted) {
    throw new ICalParseError('invalid_line', 'iCalendar contains an unterminated parameter.');
  }
  pieces.push(current);
  return pieces;
}

function parseContentLine(line: string, lineNumber: number): RawProperty {
  const separator = line.indexOf(':');
  if (separator <= 0) {
    throw new ICalParseError(
      'invalid_line',
      'iCalendar property is missing its value.',
      lineNumber,
    );
  }
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const pieces = splitParameters(left);
  const name = pieces[0]?.toUpperCase();
  if (name === undefined || !/^[A-Z0-9-]+$/u.test(name)) {
    throw new ICalParseError('invalid_line', 'iCalendar property name is invalid.', lineNumber);
  }

  const parameters: Record<string, string> = {};
  for (const parameter of pieces.slice(1)) {
    const equals = parameter.indexOf('=');
    if (equals <= 0) {
      throw new ICalParseError('invalid_line', 'iCalendar parameter is invalid.', lineNumber);
    }
    const key = parameter.slice(0, equals).toUpperCase();
    let parameterValue = parameter.slice(equals + 1);
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"')) {
      parameterValue = parameterValue.slice(1, -1);
    }
    if (!/^[A-Z0-9-]+$/u.test(key) || parameterValue.length === 0) {
      throw new ICalParseError('invalid_line', 'iCalendar parameter is invalid.', lineNumber);
    }
    if (parameters[key] !== undefined) {
      throw new ICalParseError(
        'duplicate_property',
        'iCalendar parameter is duplicated.',
        lineNumber,
      );
    }
    parameters[key] = parameterValue;
  }

  return { name, parameters, value, line: lineNumber };
}

function unescapeText(value: string, line: number): string {
  let unescaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character !== '\\') {
      unescaped += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined || !'\\,;Nn'.includes(escaped)) {
      throw new ICalParseError('invalid_line', 'iCalendar text contains an invalid escape.', line);
    }
    unescaped += escaped === 'N' || escaped === 'n' ? '\n' : escaped;
    index += 1;
  }
  if (unescaped.length > ICAL_PARSE_LIMITS.maxTextLength || hasUnsafeControlCharacters(unescaped)) {
    throw new ICalParseError('text_too_long', 'iCalendar text contains unsafe content.', line);
  }
  return unescaped;
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (
      code === 0 ||
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function hasAnyControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code <= 31 || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

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

function parseDateProperty(property: RawProperty): string {
  if (
    property.parameters['TZID'] !== undefined ||
    property.parameters['VALUE']?.toUpperCase() !== 'DATE'
  ) {
    throw new ICalParseError(
      'ambiguous_timezone',
      'timed or timezone-qualified calendar events are not supported.',
      property.line,
    );
  }
  if (!/^\d{8}$/u.test(property.value)) {
    throw new ICalParseError(
      'invalid_date',
      'calendar date must use the YYYYMMDD form.',
      property.line,
    );
  }
  const year = Number(property.value.slice(0, 4));
  const month = Number(property.value.slice(4, 6));
  const day = Number(property.value.slice(6, 8));
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new ICalParseError('invalid_date', 'calendar date is not valid.', property.line);
  }
  return `${property.value.slice(0, 4)}-${property.value.slice(4, 6)}-${property.value.slice(6, 8)}`;
}

function parseTimestamp(property: RawProperty): string {
  if (property.parameters['TZID'] !== undefined || !/Z$/u.test(property.value)) {
    throw new ICalParseError(
      'ambiguous_timezone',
      'calendar metadata timestamp must be an explicit UTC value.',
      property.line,
    );
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(property.value);
  if (match === null) {
    throw new ICalParseError('invalid_timestamp', 'calendar timestamp is invalid.', property.line);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ICalParseError('invalid_timestamp', 'calendar timestamp is invalid.', property.line);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const timestamp = date.getTime();
  if (
    !Number.isFinite(timestamp) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new ICalParseError('invalid_timestamp', 'calendar timestamp is invalid.', property.line);
  }
  return date.toISOString();
}

function propertyValue(
  properties: ReadonlyMap<string, RawProperty>,
  name: string,
  eventLine: number,
): RawProperty {
  const property = properties.get(name);
  if (property === undefined || property.value.length === 0) {
    throw new ICalParseError(
      'missing_property',
      `${name} is required for a calendar event.`,
      eventLine,
    );
  }
  return property;
}

function parseEvent(raw: RawEvent): ICalEvent {
  const uidProperty = propertyValue(raw.properties, 'UID', raw.line);
  const rawUid = uidProperty.value;
  if (rawUid.length === 0 || /^\s|\s$/u.test(rawUid) || hasAnyControlCharacters(rawUid)) {
    throw new ICalParseError(
      'invalid_uid',
      'calendar event UID contains boundary whitespace or control characters.',
      uidProperty.line,
    );
  }
  const uid = unescapeText(rawUid, uidProperty.line);
  if (
    uid.length === 0 ||
    uid.length > ICAL_PARSE_LIMITS.maxUidLength ||
    hasAnyControlCharacters(uid)
  ) {
    throw new ICalParseError(
      'invalid_uid',
      'calendar event UID must be bounded text without control characters.',
      uidProperty.line,
    );
  }

  const start = parseDateProperty(propertyValue(raw.properties, 'DTSTART', raw.line));
  const end = parseDateProperty(propertyValue(raw.properties, 'DTEND', raw.line));
  const startDay = dayNumber(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)),
    Number(start.slice(8, 10)),
  );
  const endDay = dayNumber(
    Number(end.slice(0, 4)),
    Number(end.slice(5, 7)),
    Number(end.slice(8, 10)),
  );
  const nights = endDay - startDay;
  if (nights <= 0 || nights > ICAL_PARSE_LIMITS.maxNights) {
    throw new ICalParseError(
      'invalid_interval',
      'calendar event interval is outside the supported bound.',
      raw.line,
    );
  }

  const statusProperty = raw.properties.get('STATUS');
  const statusValue =
    statusProperty === undefined ? 'CONFIRMED' : statusProperty.value.toUpperCase();
  let status: ICalEventStatus;
  if (statusValue === 'CONFIRMED') {
    status = 'confirmed';
  } else if (statusValue === 'TENTATIVE') {
    status = 'tentative';
  } else if (statusValue === 'CANCELLED') {
    status = 'cancelled';
  } else {
    throw new ICalParseError(
      'invalid_status',
      'calendar event status is not supported.',
      statusProperty?.line ?? raw.line,
    );
  }

  const transparencyProperty = raw.properties.get('TRANSP');
  const transparencyValue =
    transparencyProperty === undefined ? 'OPAQUE' : transparencyProperty.value.toUpperCase();
  if (transparencyValue !== 'OPAQUE' && transparencyValue !== 'TRANSPARENT') {
    throw new ICalParseError(
      'invalid_transparency',
      'calendar event transparency is not supported.',
      transparencyProperty?.line ?? raw.line,
    );
  }

  const sequenceProperty = raw.properties.get('SEQUENCE');
  let sequence: number | null = null;
  if (sequenceProperty !== undefined) {
    if (!/^\+?\d+$/u.test(sequenceProperty.value)) {
      throw new ICalParseError(
        'invalid_sequence',
        'calendar event sequence is invalid.',
        sequenceProperty.line,
      );
    }
    sequence = Number(sequenceProperty.value);
    if (!Number.isInteger(sequence) || sequence > ICAL_SEQUENCE_MAX) {
      throw new ICalParseError(
        'invalid_sequence',
        'calendar event sequence is invalid.',
        sequenceProperty.line,
      );
    }
  }

  const lastModifiedProperty = raw.properties.get('LAST-MODIFIED');
  const lastModified =
    lastModifiedProperty === undefined ? null : parseTimestamp(lastModifiedProperty);
  const stampProperty = raw.properties.get('DTSTAMP');
  if (stampProperty !== undefined) {
    parseTimestamp(stampProperty);
  }
  const summaryProperty = raw.properties.get('SUMMARY');
  const summary =
    summaryProperty === undefined
      ? null
      : unescapeText(summaryProperty.value, summaryProperty.line);

  return Object.freeze({
    uid,
    arrival: start,
    departure: end,
    status: transparencyValue === 'TRANSPARENT' ? 'cancelled' : status,
    sequence,
    lastModified,
    summary,
  });
}

function beginComponent(value: string, line: number): 'VCALENDAR' | 'VEVENT' {
  if (value === 'VCALENDAR' || value === 'VEVENT') {
    return value;
  }
  throw new ICalParseError(
    'invalid_component',
    'iCalendar contains an unsupported component.',
    line,
  );
}

export function parseICalCalendar(
  input: string | Uint8Array,
  options: ICalParseOptions = {},
): ICalCalendar {
  const maxBytes = parseLimit(options.maxBytes, ICAL_PARSE_LIMITS.maxBytes, 'maxBytes');
  const maxEvents = parseLimit(options.maxEvents, ICAL_PARSE_LIMITS.maxEvents, 'maxEvents');
  const maxLineLength = parseLimit(
    options.maxLineLength,
    ICAL_PARSE_LIMITS.maxLineLength,
    'maxLineLength',
  );
  const lines = unfoldLines(decodeInput(input, maxBytes), maxLineLength);
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR') {
    throw new ICalParseError('missing_calendar', 'iCalendar must begin with VCALENDAR.');
  }

  let component: 'VCALENDAR' | 'VEVENT' | null = null;
  let calendarEnded = false;
  let currentEvent: {
    readonly properties: Map<string, RawProperty>;
    readonly line: number;
  } | null = null;
  const parsedEvents: ICalEvent[] = [];
  let eventCount = 0;
  let prodId: string | null = null;
  const seenUids = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const lineNumber = index + 1;
    if (index === 0) {
      component = 'VCALENDAR';
      continue;
    }

    const structuralLine = line.toUpperCase();
    if (structuralLine === 'BEGIN:VCALENDAR' || structuralLine === 'BEGIN:VEVENT') {
      const requested = beginComponent(structuralLine.slice('BEGIN:'.length), lineNumber);
      if (requested === 'VEVENT') {
        if (component !== 'VCALENDAR' || currentEvent !== null) {
          throw new ICalParseError(
            'invalid_component',
            'VEVENT is nested in an invalid component.',
            lineNumber,
          );
        }
        if (eventCount >= maxEvents) {
          throw new ICalParseError(
            'event_limit',
            'iCalendar event count exceeds the configured limit.',
            lineNumber,
          );
        }
        eventCount += 1;
        currentEvent = { properties: new Map(), line: lineNumber };
        component = 'VEVENT';
      } else {
        throw new ICalParseError(
          'invalid_component',
          'VCALENDAR may only appear once.',
          lineNumber,
        );
      }
      continue;
    }

    if (structuralLine === 'END:VEVENT') {
      if (component !== 'VEVENT' || currentEvent === null) {
        throw new ICalParseError(
          'invalid_component',
          'VEVENT end marker is out of order.',
          lineNumber,
        );
      }
      const parsedEvent = parseEvent({
        properties: currentEvent.properties,
        line: currentEvent.line,
      });
      if (seenUids.has(parsedEvent.uid)) {
        throw new ICalParseError(
          'duplicate_uid',
          'iCalendar contains a duplicate event UID.',
          lineNumber,
        );
      }
      seenUids.add(parsedEvent.uid);
      parsedEvents.push(parsedEvent);
      currentEvent = null;
      component = 'VCALENDAR';
      continue;
    }

    if (structuralLine === 'END:VCALENDAR') {
      if (component !== 'VCALENDAR' || currentEvent !== null || calendarEnded) {
        throw new ICalParseError(
          'invalid_component',
          currentEvent === null
            ? 'VCALENDAR end marker is out of order.'
            : 'VEVENT is missing its closing end marker.',
          lineNumber,
        );
      }
      calendarEnded = true;
      component = null;
      continue;
    }

    const property = parseContentLine(line, lineNumber);
    if (property.name === 'BEGIN' || property.name === 'END') {
      throw new ICalParseError(
        'invalid_component',
        'iCalendar contains an unsupported component marker.',
        property.line,
      );
    }
    if (component === 'VEVENT' && currentEvent !== null) {
      if (RECURRENCE_PROPERTIES[property.name] === true) {
        throw new ICalParseError(
          'unsupported_recurrence',
          'recurring calendar events are not supported.',
          property.line,
        );
      }
      if (
        UNIQUE_EVENT_PROPERTIES[property.name] === true &&
        currentEvent.properties.has(property.name)
      ) {
        throw new ICalParseError(
          'duplicate_property',
          'calendar event property is duplicated.',
          lineNumber,
        );
      }
      currentEvent.properties.set(property.name, property);
      continue;
    }
    if (component !== 'VCALENDAR') {
      throw new ICalParseError(
        'invalid_component',
        'iCalendar property is outside a component.',
        lineNumber,
      );
    }
    if (property.name === 'PRODID') {
      prodId = unescapeText(property.value, property.line);
    }
  }

  if (!calendarEnded || component !== null) {
    throw new ICalParseError('missing_calendar', 'iCalendar is missing a closing VCALENDAR.');
  }
  return Object.freeze({
    prodId,
    events: Object.freeze(parsedEvents),
  });
}
