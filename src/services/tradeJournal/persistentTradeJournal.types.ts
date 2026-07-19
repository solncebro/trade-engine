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
  reconcileTimeIsIsoString: boolean;
  updatedAtColumn: string | null;
  paperStateKeyColumn: string;
  sheetColumnList: readonly string[];
  sheetDateColumnList: readonly string[];
  sheetPercentColumnList: readonly string[];
  event: TradeJournalEventSchema;
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

export interface JournalSelectRowsArgs {
  table: string;
  match: Record<string, unknown>;
  limit?: number;
}
