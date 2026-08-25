/** Normalized calendar-channel boundary shared by concrete channel adapters. */
export interface ExternalCalendarBlock {
  readonly source: string;
  readonly externalId: string;
  readonly arrival: string;
  readonly departure: string;
  readonly status?: 'active' | 'cancelled';
  readonly sequence?: number | null;
  readonly lastModified?: string | null;
}

export interface CalendarChannel {
  importBlocks(): Promise<readonly ExternalCalendarBlock[]>;
}
