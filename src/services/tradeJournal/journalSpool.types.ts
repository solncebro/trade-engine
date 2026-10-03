export interface JournalSpoolSummaryEntry {
  kind: 'summary';
  /** Value of the schema's summary key column. */
  key: string;
  row: Record<string, unknown>;
}

export interface JournalSpoolEventEntry {
  kind: 'event';
  /** The trade the event belongs to (the id handed to `enqueueEvent`). */
  tradeKey: string;
  row: Record<string, unknown>;
}

export type JournalSpoolEntry = JournalSpoolSummaryEntry | JournalSpoolEventEntry;
