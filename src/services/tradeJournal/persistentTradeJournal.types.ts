export interface TradeJournalEventSchema {
  tradeKeyColumn: string;
  seqColumn: string | null;
}

export interface TradeJournalSchema {
  tradesTable: string;
  eventsTable: string;
  paperStateTable: string;
  summaryKeyColumn: string;
  statusColumn: string;
  terminalStatusList: readonly string[];
  modeColumn: string | null;
  reconcileTimeColumn: string;
  /** Column the FULL sheet rewrite orders rows by. A sheet is read top to bottom by a person, so the
   *  order has to be the one that means something to them — for a trade journal that is when the trade
   *  went on, not when its row was last touched. Omitted: falls back to `reconcileTimeColumn`. */
  sheetOrderColumn?: string;
  reconcileTimeIsIsoString: boolean;
  updatedAtColumn: string | null;
  paperStateKeyColumn: string;
  sheetColumnList: readonly string[];
  sheetDateColumnList: readonly string[];
  sheetPercentColumnList: readonly string[];
  event: TradeJournalEventSchema;
}

/** One sheet (tab) of the spreadsheet and the summary rows it shows — e.g. "Сделки" with every row and
 *  one sheet per trader with that trader's rows. Missing sheets are created with the header. */
export interface JournalSheetTarget {
  sheetName: string;
  shouldIncludeRow: (row: Record<string, unknown>) => boolean;
}

export interface PersistentTradeJournalConfig {
  schema: TradeJournalSchema;
  supabaseUrl: string | null;
  supabaseServiceKey: string | null;
  googleSheetsSpreadsheetId: string | null;
  googleSheetsCredentialsPath: string | null;
  flushIntervalMs?: number;
  sheetSyncDebounceMs?: number;
  liveSheetMirror?: boolean;
  retryBaseDelayMs?: number;
  /** JSONL file for rows the database did not take after every retry. With it nothing is lost across a
   *  DB outage or a restart: failed summaries AND events land here and are replayed on `initialize()`
   *  and after the next successful flush. Omitted/null: RAM only, as before — failed events are dropped. */
  spoolFilePath?: string | null;
  /** Named sheets for the live mirror, the reconcile and the full sync. Omitted/empty: the FIRST sheet
   *  gets every row, as before. */
  sheetTargetList?: JournalSheetTarget[];
}

export interface MarkOrphanedArgs {
  resumedIdList: string[];
  orphanStatus: string;
  activeStatusList: readonly string[];
  modeValue?: string;
}

export interface JournalUpdateRowsArgs {
  table: string;
  match: Record<string, unknown>;
  patch: Record<string, unknown>;
  notEqual?: { column: string; value: unknown };
}

/**
 * Полуоткрытый отрезок по одной колонке: от `fromValue` включительно до `toValue` НЕ включительно.
 * Именно так режутся периоды календаря — сутки кончаются ровно там, где начинаются следующие, и
 * сделка на границе обязана попасть ровно в один период, а не в оба.
 */
export interface JournalSelectRangeArgs {
  column: string;
  fromValue: number | string;
  toValue?: number | string;
}

export interface JournalSelectRowsArgs {
  table: string;
  match: Record<string, unknown>;
  limit?: number;
  range?: JournalSelectRangeArgs;
  order?: { column: string; ascending: boolean };
}
