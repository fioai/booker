import type { CalendarChannel } from '@booking-engine/channel-calendar';

import { createICalFetcher, type ICalFetcher } from './fetch.js';
import { parseICalCalendar } from './parse.js';

export interface ICalChannel extends CalendarChannel {
  readonly format: 'ical';
}

export interface ICalChannelOptions {
  readonly sourceId: string;
  readonly url: string;
  readonly fetcher?: ICalFetcher;
}

export function createICalChannel(options: ICalChannelOptions): ICalChannel {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(options.sourceId)) {
    throw new TypeError('iCalendar sourceId must be a bounded identifier.');
  }
  const fetcher = options.fetcher ?? createICalFetcher();
  return {
    format: 'ical',
    async importBlocks() {
      const feed = await fetcher.fetch(options.url);
      const calendar = parseICalCalendar(feed.body);
      return Object.freeze(
        calendar.events.map((event) =>
          Object.freeze({
            source: options.sourceId,
            externalId: event.uid,
            arrival: event.arrival,
            departure: event.departure,
            status: event.status === 'cancelled' ? ('cancelled' as const) : ('active' as const),
            sequence: event.sequence,
            lastModified: event.lastModified,
          }),
        ),
      );
    },
  };
}

export { ICAL_SEQUENCE_MAX } from './protocol-limits.js';
export * from './export.js';
export * from './fetch.js';
export * from './parse.js';
export * from './reconcile.js';
