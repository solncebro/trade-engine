import { sheets_v4 } from '@googleapis/sheets';
import { SupabaseClient } from '@supabase/supabase-js';
import type { PostgrestSingleResponse } from '@supabase/supabase-js';

import { JournalSpool } from './journalSpool';
import type { JournalSpoolEntry, JournalSpoolEventEntry } from './journalSpool.types';
import type {
  JournalSelectRowsArgs,
  JournalSheetTarget,
  JournalUpdateRowsArgs,
  MarkOrphanedArgs,
  PersistentTradeJournalConfig,
  ReconcileSheetsFromSupabaseArgs,
  TradeJournalSchema,
} from './persistentTradeJournal.types';
import {
  createSheetsClient,
  ensureDateColumnFormat,
  ensureSheetHeader,
  fullReplaceSheet,
  replaceSheetValues,
  syncRecordListToSheet,
} from './sheetsSync';
import type { SheetSyncArgs } from './sheetsSync.types';

import { logger } from '../../core/logger';
import { withResultRetry } from '../../core/withRetryOn429';
import { createDate } from '../../utils/date.utils';
import { createSupabaseServiceClient } from '../supabase/supabaseStorage';

const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_SHEET_SYNC_DEBOUNCE_MS = 30_000;
const SUPABASE_PAGE_SIZE = 1_000;
const MS_PER_DAY = 86_400_000;
// A routine reconcile only has to catch rows changed recently; reading the whole table every time
// grew with the journal. The whole table is an explicit `{ isFull: true }`.
const DEFAULT_SHEET_RECONCILE_LOOKBACK_DAYS = 7;
const SUPABASE_MAX_ATTEMPTS = 3;
const SUPABASE_RETRY_BASE_DELAY_MS = 500;

interface QueuedJournalEvent {
  tradeKey: string;
  row: Record<string, unknown>;
}

interface BatchPersistOutcome {
  /** The summaries are in the database — terminal ones may leave RAM. */
  isSummaryPersisted: boolean;
  /** The summaries are in the database OR in the on-disk spool — no RAM re-queue needed. */
  isSummarySafe: boolean;
}

// Generic, buffered trade journal: batches trade summaries and events in RAM, flushes them to Supabase
// in bulk, and mirrors the summaries into Google Sheets. It owns the Supabase and Sheets clients so a
// consuming project only describes its table schema and calls put/patch/enqueue — it never touches the
// transport, the retry queue, or the debounce. On a DB outage nothing is lost: unsaved rows and events
// return to the queue and the next tick retries them.
export class PersistentTradeJournal {
  private readonly schema: TradeJournalSchema;
  private readonly googleSheetsSpreadsheetId: string | null;
  private readonly googleSheetsCredentialsPath: string | null;
  private readonly flushIntervalMs: number;
  private readonly sheetSyncDebounceMs: number;
  private readonly liveSheetMirror: boolean;
  private readonly retryBaseDelayMs: number;
  private readonly sheetTargetList: readonly JournalSheetTarget[];
  private readonly spool: JournalSpool | null;
  private isSpoolPending = false;
  private serialChain: Promise<void> = Promise.resolve();
  private readonly summaryById: Map<string, Record<string, unknown>> = new Map();
  private readonly seqById: Map<string, number> = new Map();
  private readonly dirtyIdSet: Set<string> = new Set();
  private eventQueueList: QueuedJournalEvent[] = [];
  private supabaseClient: SupabaseClient | null = null;
  private isSupabaseEnabled = false;
  private isSheetsEnabled = false;
  private sheetsClient: sheets_v4.Sheets | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSheetSyncMs = 0;
  private isSheetSyncInProgress = false;

  constructor(config: PersistentTradeJournalConfig) {
    this.schema = config.schema;
    this.googleSheetsSpreadsheetId = config.googleSheetsSpreadsheetId;
    this.googleSheetsCredentialsPath = config.googleSheetsCredentialsPath;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.sheetSyncDebounceMs = config.sheetSyncDebounceMs ?? DEFAULT_SHEET_SYNC_DEBOUNCE_MS;
    this.liveSheetMirror = config.liveSheetMirror ?? false;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? SUPABASE_RETRY_BASE_DELAY_MS;
    this.sheetTargetList = config.sheetTargetList ?? [];
    this.spool = config.spoolFilePath !== undefined && config.spoolFilePath !== null ? new JournalSpool(config.spoolFilePath) : null;

    if (config.supabaseUrl !== null && config.supabaseServiceKey !== null) {
      this.supabaseClient = createSupabaseServiceClient({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey });
      this.isSupabaseEnabled = true;
    }

    if (this.googleSheetsSpreadsheetId !== null && this.googleSheetsCredentialsPath !== null) {
      this.isSheetsEnabled = true;
    }
  }

  async initialize(): Promise<void> {
    await this.initializeSheetsChannel();

    await this.initializeSpool();

    if (this.isEnabled()) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((error: unknown) => {
          logger.error({ error }, '[PersistentTradeJournal] Flush tick failed');
        });
      }, this.flushIntervalMs).unref();
    }

    logger.info(
      { tradesTable: this.schema.tradesTable, eventsTable: this.schema.eventsTable, isSupabaseEnabled: this.isSupabaseEnabled, isSheetsEnabled: this.isSheetsEnabled, spoolFilePath: this.spool?.getFilePath() ?? null },
      `[PersistentTradeJournal] Initialized (supabase: ${this.isSupabaseEnabled}, sheets: ${this.isSheetsEnabled}, spool: ${this.spool !== null})`,
    );
  }

  private async initializeSheetsChannel(): Promise<boolean> {
    if (this.isSheetsEnabled && this.sheetsClient !== null) return true;

    if (this.googleSheetsCredentialsPath === null || this.googleSheetsSpreadsheetId === null) return false;

    logger.info({ table: this.schema.tradesTable, stage: 'sheets_connect_started' }, '[PersistentTradeJournal] Connecting configured Google Sheets channel');

    try {
      this.sheetsClient = createSheetsClient(this.googleSheetsCredentialsPath);

      for (const sheetName of this.sheetNameList) {
        await ensureSheetHeader({ sheets: this.sheetsClient, spreadsheetId: this.googleSheetsSpreadsheetId, columnList: this.schema.sheetColumnList, sheetName });
        await ensureDateColumnFormat({
          sheets: this.sheetsClient,
          spreadsheetId: this.googleSheetsSpreadsheetId,
          columnList: this.schema.sheetColumnList,
          dateColumnList: this.schema.sheetDateColumnList,
          numberFormatByColumn: this.schema.sheetNumberFormatByColumn,
          sheetName,
        });
      }
      this.isSheetsEnabled = true;
      logger.info({ table: this.schema.tradesTable, stage: 'sheets_connect_confirmed' }, '[PersistentTradeJournal] Google Sheets channel connected');

      return true;
    } catch (error: unknown) {
      logger.error({ errorMessage: error instanceof Error ? error.message : String(error), table: this.schema.tradesTable, stage: 'sheets_connect_failed', willRetryOnReconcile: true }, '[PersistentTradeJournal] Failed to connect Google Sheets — the next reconciliation will retry');
      this.isSheetsEnabled = false;
      this.sheetsClient = null;

      return false;
    }
  }

  /** The journal's own Supabase client (null when Supabase is off) — for Storage uploads and other
   *  tables, so an app never builds a second client from the same key. */
  getSupabaseClient(): SupabaseClient | null {
    return this.supabaseClient;
  }

  // A restart must continue where the spool left off: seed the per-trade event counters from it (or a
  // new event would reuse a spooled seq and be skipped as a duplicate on replay), then try to replay.
  private async initializeSpool(): Promise<void> {
    if (this.spool === null || !this.isSupabaseEnabled) {
      return;
    }

    let entryList: JournalSpoolEntry[];

    try {
      entryList = await this.spool.readEntryList();
    } catch (error: unknown) {
      logger.error({ error, filePath: this.spool.getFilePath() }, '[PersistentTradeJournal] Failed to read the on-disk spool at startup — it will be retried on the next flush');
      this.isSpoolPending = true;

      return;
    }

    if (entryList.length === 0) {
      return;
    }

    this.isSpoolPending = true;
    this.seedSeqCountersFromSpool(entryList);

    logger.warn({ entryCount: entryList.length }, `[PersistentTradeJournal] Found ${entryList.length} unsaved journal row(s) on disk from a previous run — replaying`);

    await this.runSerialized(async () => {
      await this.replaySpool();
    });
  }

  private seedSeqCountersFromSpool(entryList: JournalSpoolEntry[]): void {
    const seqColumn = this.schema.event.seqColumn;

    if (seqColumn === null) {
      return;
    }

    for (const entry of entryList) {
      if (entry.kind !== 'event') {
        continue;
      }

      const seq = Number(entry.row[seqColumn]);

      if (Number.isFinite(seq) && seq > (this.seqById.get(entry.tradeKey) ?? 0)) {
        this.seqById.set(entry.tradeKey, seq);
      }
    }
  }

  isEnabled(): boolean {
    return this.isSupabaseEnabled || this.isSheetsEnabled;
  }

  // Create or replace an in-RAM trade summary and mark it dirty for the next flush.
  putSummary(id: string, row: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      return;
    }

    this.summaryById.set(id, { ...row });
    this.dirtyIdSet.add(id);
  }

  // Patch fields of an existing summary. A patch for an unknown id would silently vanish — scream so the
  // regression (e.g. a resumed trade whose summary was not rehydrated) is visible, not swallowed.
  patchSummary(id: string, partialRow: Record<string, unknown>): void {
    const summary = this.summaryById.get(id);

    if (summary === undefined) {
      if (this.isEnabled()) {
        logger.warn({ id }, '[PersistentTradeJournal] patchSummary skipped — no in-memory summary (resumed trade not rehydrated?)');
      }

      return;
    }

    Object.assign(summary, partialRow);

    if (this.schema.updatedAtColumn !== null) {
      summary[this.schema.updatedAtColumn] = createDate().toISOString();
    }

    this.dirtyIdSet.add(id);
  }

  // Read-only snapshot of an in-RAM summary so a domain wrapper can derive computed fields (e.g. a trade
  // duration from the stored created_at, or a fib range from the current low/high). Returns a copy so the
  // caller cannot mutate RAM directly; undefined when the summary is not in RAM (never journaled here, or
  // already evicted / not rehydrated).
  getSummary(id: string): Record<string, unknown> | undefined {
    const summary = this.summaryById.get(id);

    return summary === undefined ? undefined : { ...summary };
  }

  enqueueEvent(tradeId: string, eventRow: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      return;
    }

    const row: Record<string, unknown> = { ...eventRow };

    if (this.schema.event.seqColumn !== null) {
      const seq = (this.seqById.get(tradeId) ?? 0) + 1;
      this.seqById.set(tradeId, seq);
      row[this.schema.event.seqColumn] = seq;
    }

    this.eventQueueList.push({ tradeKey: tradeId, row });
  }

  // Immediately persist a single summary, bypassing the batched flush. Used before dropping a closed
  // setup's resume state so the terminal status is guaranteed in the DB first. Returns false when there
  // is no summary to persist — the caller must then KEEP the resume state so the trade replays.
  async flushSummaryNow(id: string): Promise<boolean> {
    return this.runSerialized(() => this.flushSummaryConfirmed(id));
  }

  private async flushSummaryConfirmed(id: string): Promise<boolean> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return true;
    }

    const summary = this.summaryById.get(id);

    if (summary === undefined) {
      logger.warn({ id }, '[PersistentTradeJournal] flushSummaryNow — no in-memory summary; keeping resume state so the trade replays');

      return false;
    }

    const client = this.supabaseClient;
    const startedAt = Date.now();
    logger.info({ table: this.schema.tradesTable, tradeId: id, status: summary[this.schema.statusColumn], stage: 'summary_write_started' }, '[PersistentTradeJournal] Immediate summary write started');
    const { error, status } = await withResultRetry({
      fn: () => this.persistSummaryList(client, [{ ...summary }]),
      contextLabel: 'flushSummaryNow',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      logger.error({ table: this.schema.tradesTable, tradeId: id, stage: 'summary_write_failed', status, errorCode: error.code, errorMessage: error.message, elapsedMs: Date.now() - startedAt }, '[PersistentTradeJournal] Immediate summary write failed; resume state must be retained');
    } else {
      logger.info({ table: this.schema.tradesTable, tradeId: id, stage: 'summary_write_confirmed', elapsedMs: Date.now() - startedAt }, '[PersistentTradeJournal] Immediate summary write confirmed');
    }

    return error === null;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      await this.flush();
    } catch (error: unknown) {
      logger.warn({ error, isSpoolEnabled: this.spool !== null }, this.spool === null
        ? '[PersistentTradeJournal] Final flush on shutdown failed — some journal rows may be lost'
        : '[PersistentTradeJournal] Final flush on shutdown failed — unsaved rows are in the on-disk spool when it was writable');
    }
  }

  // Re-attach summaries into RAM after a restart so resumed trades can keep journaling and, crucially,
  // write their terminal status when they close. Without this every patch/finalize for a resumed trade
  // silently no-ops. Idempotent; graceful when Supabase is off or a row is absent.
  async rehydrateSummaries(idList: string[]): Promise<void> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null || idList.length === 0) {
      return;
    }

    const missingIdList = idList.filter((id) => !this.summaryById.has(id));

    if (missingIdList.length === 0) {
      return;
    }

    const client = this.supabaseClient;
    const { data, error } = await withResultRetry({
      fn: async () => client.from(this.schema.tradesTable).select('*').in(this.schema.summaryKeyColumn, missingIdList),
      contextLabel: 'rehydrateSummaries',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      return;
    }

    const loadedIdList: string[] = [];
    const spooledSummaryByKey = await this.readSpooledSummaryByKey();

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = String(row[this.schema.summaryKeyColumn]);
      // A summary still waiting in the spool is NEWER than its database row — it is the one the
      // database refused. Loading the older row would let the next replay write it back over the newer.
      this.summaryById.set(id, spooledSummaryByKey.get(id) ?? row);
      loadedIdList.push(id);
    }

    // A trade whose very first write never reached the database lives only in the spool.
    for (const id of missingIdList) {
      const spooledRow = spooledSummaryByKey.get(id);

      if (!this.summaryById.has(id) && spooledRow !== undefined) {
        this.summaryById.set(id, spooledRow);
        loadedIdList.push(id);
      }
    }

    await this.restoreEventSeqCounters(loadedIdList);

    logger.info({ requested: idList.length, rehydrated: loadedIdList.length }, `[PersistentTradeJournal] Rehydrated ${loadedIdList.length} summary(ies) after restart`);
  }

  private async restoreEventSeqCounters(idList: string[]): Promise<void> {
    const seqColumn = this.schema.event.seqColumn;

    if (seqColumn === null || this.supabaseClient === null || idList.length === 0) {
      return;
    }

    const client = this.supabaseClient;
    const { data, error } = await withResultRetry({
      fn: async () => client.from(this.schema.eventsTable).select('*').in(this.schema.event.tradeKeyColumn, idList),
      contextLabel: 'restoreEventSeqCounters',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      return;
    }

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const tradeId = String(row[this.schema.event.tradeKeyColumn]);
      const seq = Number(row[seqColumn]);
      const currentMax = this.seqById.get(tradeId) ?? 0;

      if (seq > currentMax) {
        this.seqById.set(tradeId, seq);
      }
    }
  }

  // Mark active trades that are NOT being resumed (no persisted state) with an orphan status. Called on
  // startup with the resumed ids; an empty list marks every active trade as orphaned.
  async markOrphaned(args: MarkOrphanedArgs): Promise<void> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return;
    }

    const client = this.supabaseClient;
    const { data, error } = await withResultRetry({
      fn: async () => {
        let query = client
          .from(this.schema.tradesTable)
          .update({ [this.schema.statusColumn]: args.orphanStatus, ...this.buildUpdatedAtPatch() })
          .in(this.schema.statusColumn, [...args.activeStatusList]);

        if (this.schema.modeColumn !== null && args.modeValue !== undefined) {
          query = query.eq(this.schema.modeColumn, args.modeValue);
        }

        if (args.resumedIdList.length > 0) {
          query = query.not(this.schema.summaryKeyColumn, 'in', `(${args.resumedIdList.join(',')})`);
        }

        return query.select(this.schema.summaryKeyColumn);
      },
      contextLabel: 'markOrphaned',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      return;
    }

    const orphanedCount = (data ?? []).length;
    logger.info({ orphanedCount, resumedCount: args.resumedIdList.length }, `[PersistentTradeJournal] Marked ${orphanedCount} orphaned trade(s) as ${args.orphanStatus}`);
  }

  async savePaperState(row: Record<string, unknown>): Promise<void> {
    await this.savePaperStateConfirmed(row);
  }

  async savePaperStateConfirmed(row: Record<string, unknown>): Promise<boolean> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return false;
    }

    const client = this.supabaseClient;

    const { error } = await withResultRetry({
      fn: async () => client.from(this.schema.paperStateTable).upsert(row, { onConflict: this.schema.paperStateKeyColumn }),
      contextLabel: 'savePaperState',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      // A missing paper_state means restart recovery will NOT resume this position — surface it loudly
      // instead of leaving an "open" trades row with no resume anchor after a DB blip at open time.
      logger.error({ error }, '[PersistentTradeJournal] savePaperState failed after retries — restart recovery may not resume this position');
    }

    return error === null;
  }

  async loadPaperStateList(): Promise<Record<string, unknown>[]> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return [];
    }

    const client = this.supabaseClient;
    const { data, error } = await withResultRetry({
      fn: async () => client.from(this.schema.paperStateTable).select('*'),
      contextLabel: 'loadPaperStateList',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    // Throw on a read failure so the caller can tell "no open positions" from "could not read" — the
    // latter must NOT be treated as an empty resume set (that would abandon live positions on restart).
    if (error !== null) {
      throw new Error(`loadPaperStateList read failed after retries: ${error.message}`);
    }

    return (data ?? []) as Record<string, unknown>[];
  }

  async removePaperState(keyValue: string): Promise<void> {
    await this.removePaperStateConfirmed(keyValue);
  }

  async removePaperStateConfirmed(keyValue: string): Promise<boolean> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return false;
    }

    const client = this.supabaseClient;

    const { error } = await withResultRetry({
      fn: async () => client.from(this.schema.paperStateTable).delete().eq(this.schema.paperStateKeyColumn, keyValue),
      contextLabel: 'removePaperState',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    return error === null;
  }

  // Generic access to an auxiliary table (e.g. ladder rungs) the project owns but must not reach with its
  // own Supabase client. Domain logic stays in the project; the transport stays here.
  async insertRow(table: string, row: Record<string, unknown>): Promise<void> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return;
    }

    const client = this.supabaseClient;

    await withResultRetry({
      fn: async () => client.from(table).insert(row),
      contextLabel: `insertRow ${table}`,
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });
  }

  async updateRows(args: JournalUpdateRowsArgs): Promise<void> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return;
    }

    const client = this.supabaseClient;

    await withResultRetry({
      fn: async () => {
        const query = client.from(args.table).update(args.patch).match(args.match);

        return args.notEqual === undefined ? query : query.neq(args.notEqual.column, args.notEqual.value);
      },
      contextLabel: `updateRows ${args.table}`,
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });
  }

  async selectRows(args: JournalSelectRowsArgs): Promise<Record<string, unknown>[]> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return [];
    }

    const client = this.supabaseClient;
    const { data, error } = await withResultRetry({
      fn: async () => {
        // Каждый уточнитель необязателен и накладывается поверх предыдущего: без них запрос
        // остаётся ровно тем, чем был, — точное совпадение по match.
        const filtered = client.from(args.table).select<string, Record<string, unknown>>(args.select ?? '*').match(args.match);
        const ranged = args.range === undefined
          ? filtered
          : args.range.toValue === undefined
            ? filtered.gte(args.range.column, args.range.fromValue)
            : filtered.gte(args.range.column, args.range.fromValue).lt(args.range.column, args.range.toValue);
        const ordered = args.order === undefined
          ? ranged
          : ranged.order(args.order.column, { ascending: args.order.ascending });

        return args.limit === undefined ? ordered : ordered.limit(args.limit);
      },
      contextLabel: `selectRows ${args.table}`,
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    // Throw on a read failure so callers can distinguish "no matching rows" from "could not read" — the
    // latter must not silently look like an absent trade/rung and trigger a destructive follow-up.
    if (error !== null) {
      throw new Error(`selectRows ${args.table} read failed after retries: ${error.message}`);
    }

    return (data ?? []) as Record<string, unknown>[];
  }

  // Periodic reconcile: pull trades from Supabase (the source of truth) whose reconcile time is at or
  // after `sinceMs` (default: the last 7 days; `isFull` — the whole table) and re-push them to Sheets
  // through the same sync path. Fixes closed trades whose final state never reached Sheets and were
  // already evicted from RAM. A bare number is the older «days back» form.
  async reconcileSheetsFromSupabase(args: ReconcileSheetsFromSupabaseArgs | number = {}): Promise<void> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null || this.googleSheetsSpreadsheetId === null || this.googleSheetsCredentialsPath === null) {
      return;
    }

    if (this.isSheetSyncInProgress) {
      logger.warn('[PersistentTradeJournal] Sheets reconcile skipped — another sheet sync is in progress');

      return;
    }

    this.isSheetSyncInProgress = true;
    const startedAt = Date.now();
    const window = typeof args === 'number' ? { sinceMs: startedAt - args * MS_PER_DAY } : args;
    const sinceMs = window.isFull === true ? null : window.sinceMs ?? startedAt - DEFAULT_SHEET_RECONCILE_LOOKBACK_DAYS * MS_PER_DAY;
    const reconcileScope = sinceMs === null ? 'complete history' : `since ${createDate(sinceMs).toISOString()}`;
    logger.info({ table: this.schema.tradesTable, stage: 'sheets_reconcile_started', reconcileScope }, '[PersistentTradeJournal] Sheets reconciliation started');

    try {
      if (!await this.initializeSheetsChannel()) return;

      const rowList = await this.fetchAllSummaryRows(sinceMs);

      if (rowList.length === 0) {
        logger.info({ sinceMs }, `[PersistentTradeJournal] Sheets reconcile — 0 trade(s) in ${reconcileScope}`);

        return;
      }

      await this.writeToSheetTargets(rowList, 'sync');

      logger.info({ table: this.schema.tradesTable, stage: 'sheets_reconcile_confirmed', tradeCount: rowList.length, sinceMs, reconcileScope, elapsedMs: Date.now() - startedAt }, `[PersistentTradeJournal] Sheets reconcile completed — ${rowList.length} trade(s) pushed`);
    } catch (error: unknown) {
      logger.error({ table: this.schema.tradesTable, stage: 'sheets_reconcile_failed', errorMessage: error instanceof Error ? error.message : String(error), sinceMs, reconcileScope, elapsedMs: Date.now() - startedAt }, '[PersistentTradeJournal] Sheets reconcile failed; the next reconciliation will retry');
    } finally {
      this.isSheetSyncInProgress = false;
    }
  }

  async fullSyncToSheet(): Promise<{ recordCount: number }> {
    if (!this.isSupabaseEnabled || !this.isSheetsEnabled || this.supabaseClient === null || this.sheetsClient === null || this.googleSheetsSpreadsheetId === null) {
      throw new Error('Full sync requires both Supabase and Google Sheets channels');
    }

    if (this.isSheetSyncInProgress) {
      throw new Error('Full sync skipped — another sheet sync is in progress');
    }

    this.isSheetSyncInProgress = true;

    try {
      const rowList = await this.fetchAllSummaryRows(null);

      await this.writeToSheetTargets(rowList, 'full');

      logger.info({ recordCount: rowList.length }, `[PersistentTradeJournal] Full sync completed — ${rowList.length} record(s) written`);

      return { recordCount: rowList.length };
    } finally {
      this.isSheetSyncInProgress = false;
    }
  }

  /**
   * Rewrite a whole named sheet with a ready table (header row included) — a summary sheet like
   * "Сводка" whose layout is not one row per trade. The sheet is created when missing. False when the
   * Sheets channel is off; a Sheets API failure is thrown so the caller can tell it apart and retry.
   */
  async replaceNamedSheet(sheetName: string, rowList: (string | number)[][]): Promise<boolean> {
    if (!this.isSheetsEnabled || this.sheetsClient === null || this.googleSheetsSpreadsheetId === null) {
      return false;
    }

    return replaceSheetValues({ sheets: this.sheetsClient, spreadsheetId: this.googleSheetsSpreadsheetId, sheetName, valueMatrix: rowList });
  }

  /** No targets configured: one pass over the FIRST sheet with every row (`undefined` name). */
  private get sheetNameList(): (string | undefined)[] {
    return this.sheetTargetList.length === 0 ? [undefined] : this.sheetTargetList.map((target) => target.sheetName);
  }

  // Every write path (live mirror, reconcile, full sync) goes through here, so a trader's sheet can
  // never disagree with the main one about which rows it shows. A full rewrite also runs for a target
  // with no rows left — that is how stale rows disappear from it.
  private async writeToSheetTargets(rowList: Record<string, unknown>[], mode: 'sync' | 'full'): Promise<void> {
    const writeSheet = mode === 'sync' ? syncRecordListToSheet : fullReplaceSheet;

    if (this.sheetTargetList.length === 0) {
      await writeSheet(this.buildSheetSyncArgs(rowList));

      return;
    }

    for (const target of this.sheetTargetList) {
      const targetRowList = rowList.filter((row) => target.shouldIncludeRow(row));

      if (mode === 'sync' && targetRowList.length === 0) {
        continue;
      }

      await writeSheet(this.buildSheetSyncArgs(targetRowList, target.sheetName));
    }
  }

  /** The column the sheet is ordered by. A sheet is read top to bottom by a person, so the order has to
   *  be the one that means something to them; for a trade journal that is when the trade went on, not
   *  when its row was last touched. Both sheet paths — the periodic reconcile and the full rewrite — use
   *  this, so a rewrite can never reshuffle the sheet into a different order than the bot appends in. */
  private get sheetOrderColumn(): string {
    return this.schema.sheetOrderColumn ?? this.schema.reconcileTimeColumn;
  }

  /** Page by page; `sinceMs` null — the whole table. */
  private async fetchAllSummaryRows(sinceMs: number | null): Promise<Record<string, unknown>[]> {
    if (this.supabaseClient === null) {
      return [];
    }

    const allRowList: Record<string, unknown>[] = [];
    const cutoff = sinceMs === null ? null : this.schema.reconcileTimeIsIsoString ? createDate(sinceMs).toISOString() : sinceMs;
    let fromIndex = 0;

    for (;;) {
      const selected = this.supabaseClient.from(this.schema.tradesTable).select('*');
      let query = (cutoff === null ? selected : selected.gte(this.schema.reconcileTimeColumn, cutoff))
        .order(this.sheetOrderColumn, { ascending: true });

      if (this.schema.summaryKeyColumn !== this.sheetOrderColumn) {
        query = query.order(this.schema.summaryKeyColumn, { ascending: true });
      }

      const { data, error } = await query.range(fromIndex, fromIndex + SUPABASE_PAGE_SIZE - 1);

      if (error !== null) {
        throw new Error(error.message);
      }

      const pageRowList = (data ?? []) as Record<string, unknown>[];
      allRowList.push(...pageRowList);

      if (pageRowList.length < SUPABASE_PAGE_SIZE) {
        break;
      }

      fromIndex += SUPABASE_PAGE_SIZE;
    }

    return allRowList;
  }

  // Flushes (timer tick, shutdown) and spool replays run one after another: a replay reads the spool,
  // writes it and then deletes it, and an append slipping in between would be deleted unsaved.
  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.serialChain.then(task);

    this.serialChain = run.then(() => undefined, () => undefined);

    return run;
  }

  private flush(): Promise<void> {
    return this.runSerialized(() => this.flushOnce());
  }

  private async flushOnce(): Promise<void> {
    if (this.eventQueueList.length === 0 && this.dirtyIdSet.size === 0 && !this.isSpoolPending) {
      return;
    }

    const eventQueueSnapshotList = this.eventQueueList;
    this.eventQueueList = [];

    const dirtyIdSnapshotList = [...this.dirtyIdSet];
    this.dirtyIdSet.clear();

    const dirtySummaryList: Record<string, unknown>[] = [];

    for (const id of dirtyIdSnapshotList) {
      const summary = this.summaryById.get(id);

      if (summary !== undefined) {
        dirtySummaryList.push(summary);
      }
    }

    const outcome: BatchPersistOutcome = this.isSupabaseEnabled
      ? await this.persistBatch(eventQueueSnapshotList, dirtySummaryList)
      : { isSummaryPersisted: true, isSummarySafe: true };

    // DB outage: re-queue ONLY the summaries — their upsert is idempotent (onConflict on the key), so a
    // re-write after a lost ack is safe. Without a spool events are NOT re-queued here: they carry fixed
    // primary keys and a plain re-queue would loop forever on a duplicate-key error and grow the queue
    // without bound, so flushToSupabase retries then DROPS the event batch on final failure (as the
    // original journal did). With a spool both already sit on disk and nothing is re-queued in RAM.
    if (!outcome.isSummarySafe) {
      for (const id of dirtyIdSnapshotList) {
        this.dirtyIdSet.add(id);
      }
    }

    if (this.isSheetsEnabled && this.liveSheetMirror) {
      await this.flushToSheets(dirtySummaryList);
    }

    if (!outcome.isSummaryPersisted) {
      return;
    }

    this.evictPersistedTerminalSummaries(dirtyIdSnapshotList);
  }

  // Evict terminal summaries that persisted and are not pending again (e.g. re-queued by the Sheets
  // mirror). Keeping them would leak memory for every closed trade.
  private evictPersistedTerminalSummaries(idList: Iterable<string>): void {
    for (const id of idList) {
      const summary = this.summaryById.get(id);

      if (summary !== undefined && this.isTerminal(summary) && !this.dirtyIdSet.has(id)) {
        this.summaryById.delete(id);
        this.seqById.delete(id);
      }
    }
  }

  private async persistBatch(eventQueueSnapshotList: QueuedJournalEvent[], dirtySummaryList: Record<string, unknown>[]): Promise<BatchPersistOutcome> {
    if (this.spool === null) {
      const isSummaryOk = await this.flushToSupabase(eventQueueSnapshotList.map((event) => event.row), dirtySummaryList);

      return { isSummaryPersisted: isSummaryOk, isSummarySafe: isSummaryOk };
    }

    const isSummaryOk = dirtySummaryList.length === 0 || await this.writeSummaryList(dirtySummaryList, 'flushSummaries');
    const isEventOk = eventQueueSnapshotList.length === 0 || await this.writeEventList(eventQueueSnapshotList.map((event) => event.row), 'flushEvents');

    if (isSummaryOk && isEventOk) {
      // The database answers again: bring back whatever an earlier outage left on disk. Order inside
      // the spool is kept; the order of events of one trade is carried by their seq column anyway.
      if (this.isSpoolPending) {
        await this.replaySpool();
      }

      return { isSummaryPersisted: true, isSummarySafe: true };
    }

    const isSpooled = await this.appendToSpool(isSummaryOk ? [] : dirtySummaryList, isEventOk ? [] : eventQueueSnapshotList);

    if (!isSpooled && !isEventOk) {
      logger.error({ eventCount: eventQueueSnapshotList.length }, '[PersistentTradeJournal] Events refused by the database AND by the on-disk spool — this batch is lost');
    }

    return { isSummaryPersisted: isSummaryOk, isSummarySafe: isSummaryOk || isSpooled };
  }

  private async appendToSpool(summaryList: Record<string, unknown>[], eventList: QueuedJournalEvent[]): Promise<boolean> {
    if (this.spool === null) {
      return false;
    }

    const entryList: JournalSpoolEntry[] = [
      ...summaryList.map((row): JournalSpoolEntry => ({ kind: 'summary', key: String(row[this.schema.summaryKeyColumn]), row: { ...row } })),
      ...eventList.map((event): JournalSpoolEntry => ({ kind: 'event', tradeKey: event.tradeKey, row: event.row })),
    ];

    if (entryList.length === 0) {
      return true;
    }

    const isAppended = await this.spool.appendEntryList(entryList);

    if (isAppended) {
      this.isSpoolPending = true;
      logger.warn(
        { summaryCount: summaryList.length, eventCount: eventList.length, filePath: this.spool.getFilePath() },
        `[PersistentTradeJournal] Database refused ${summaryList.length} summary(ies) and ${eventList.length} event(s) — kept in the on-disk spool for replay`,
      );
    }

    return isAppended;
  }

  // Replays the spool into the database. Idempotent: summaries are upserted by key (RAM wins over the
  // spool copy — it is newer), events already present (same trade key + seq, e.g. an insert whose
  // answer was lost) are skipped. The spool is deleted only after everything in it is confirmed;
  // when only the events fail, it is atomically rewritten to hold just the events.
  private async replaySpool(): Promise<boolean> {
    if (this.spool === null || !this.isSpoolPending) {
      return true;
    }

    let entryList: JournalSpoolEntry[];

    try {
      entryList = await this.spool.readEntryList();
    } catch (error: unknown) {
      logger.error({ error, filePath: this.spool.getFilePath() }, '[PersistentTradeJournal] Failed to read the on-disk spool for replay');

      return false;
    }

    const summaryRowByKey = new Map<string, Record<string, unknown>>();
    const eventEntryList: JournalSpoolEventEntry[] = [];

    for (const entry of entryList) {
      if (entry.kind === 'summary') {
        summaryRowByKey.set(entry.key, entry.row);
      } else {
        eventEntryList.push(entry);
      }
    }

    const summaryList = [...summaryRowByKey].map(([key, row]) => this.summaryById.get(key) ?? row);

    if (summaryList.length > 0 && !(await this.writeSummaryList(summaryList, 'replaySpoolSummaries'))) {
      return false;
    }

    if (eventEntryList.length > 0) {
      const pendingEventEntryList = await this.dropAlreadyStoredEvents(eventEntryList);
      const isEventOk = pendingEventEntryList !== null
        && (pendingEventEntryList.length === 0 || await this.writeEventList(pendingEventEntryList.map((entry) => entry.row), 'replaySpoolEvents'));

      if (!isEventOk) {
        await this.rewriteSpool(eventEntryList);

        return false;
      }
    }

    const isCleared = await this.rewriteSpool([]);

    if (!isCleared) {
      return false;
    }

    this.isSpoolPending = false;
    this.evictPersistedTerminalSummaries(summaryRowByKey.keys());

    logger.info(
      { summaryCount: summaryList.length, eventCount: eventEntryList.length },
      `[PersistentTradeJournal] Replayed the on-disk spool — ${summaryList.length} summary(ies), ${eventEntryList.length} event(s)`,
    );

    return true;
  }

  private async rewriteSpool(entryList: JournalSpoolEntry[]): Promise<boolean> {
    if (this.spool === null) {
      return false;
    }

    try {
      await this.spool.replaceEntryList(entryList);

      return true;
    } catch (error: unknown) {
      // The old file stays as it was — a later replay re-sends it and the key/seq checks skip the dupes.
      logger.error({ error, filePath: this.spool.getFilePath() }, '[PersistentTradeJournal] Failed to rewrite the on-disk spool');

      return false;
    }
  }

  // An event insert whose answer was lost may already be in the table. Without a seq column there is
  // no key to recognise it by, so every spooled event is re-sent. Null = could not read (replay later).
  private async dropAlreadyStoredEvents(eventEntryList: JournalSpoolEventEntry[]): Promise<JournalSpoolEventEntry[] | null> {
    const { tradeKeyColumn, seqColumn } = this.schema.event;
    const client = this.supabaseClient;

    if (seqColumn === null || client === null) {
      return eventEntryList;
    }

    const buildEventKey = (tradeKey: unknown, seq: unknown): string => `${String(tradeKey)}\u0000${String(seq)}`;
    const tradeKeyList = [...new Set(eventEntryList.map((entry) => String(entry.row[tradeKeyColumn] ?? entry.tradeKey)))];
    const { data, error } = await withResultRetry({
      fn: async () => client.from(this.schema.eventsTable).select(`${tradeKeyColumn},${seqColumn}`).in(tradeKeyColumn, tradeKeyList),
      contextLabel: 'replaySpoolExistingEvents',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      return null;
    }

    const storedEventKeySet = new Set(((data ?? []) as unknown as Record<string, unknown>[]).map((row) => buildEventKey(row[tradeKeyColumn], row[seqColumn])));

    return eventEntryList.filter((entry) => !storedEventKeySet.has(buildEventKey(entry.row[tradeKeyColumn] ?? entry.tradeKey, entry.row[seqColumn])));
  }

  private async readSpooledSummaryByKey(): Promise<Map<string, Record<string, unknown>>> {
    const summaryByKey = new Map<string, Record<string, unknown>>();

    if (this.spool === null || !this.isSpoolPending) {
      return summaryByKey;
    }

    try {
      for (const entry of await this.spool.readEntryList()) {
        if (entry.kind === 'summary') {
          summaryByKey.set(entry.key, entry.row);
        }
      }
    } catch (error: unknown) {
      logger.warn({ error }, '[PersistentTradeJournal] Could not read the on-disk spool while rehydrating — using database rows only');
    }

    return summaryByKey;
  }

  private async writeSummaryList(summaryList: Record<string, unknown>[], contextLabel: string): Promise<boolean> {
    const client = this.supabaseClient;

    if (client === null) {
      return true;
    }

    const tradeIdList = summaryList.map((row) => String(row[this.schema.summaryKeyColumn]));
    logger.info({ table: this.schema.tradesTable, tradeIdList, contextLabel, stage: 'summary_batch_started' }, '[PersistentTradeJournal] Summary batch write started');
    const { error, status } = await withResultRetry({
      fn: () => this.persistSummaryList(client, summaryList),
      contextLabel,
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      logger.error({ table: this.schema.tradesTable, tradeIdList, contextLabel, stage: 'summary_batch_failed', status, errorCode: error.code, errorMessage: error.message }, '[PersistentTradeJournal] Summary batch write failed');
    } else {
      logger.info({ table: this.schema.tradesTable, tradeIdList, contextLabel, stage: 'summary_batch_confirmed' }, '[PersistentTradeJournal] Summary batch write confirmed');
    }

    return error === null;
  }

  private async persistSummaryList(client: SupabaseClient, summaryList: Record<string, unknown>[]): Promise<PostgrestSingleResponse<null>> {
    const terminalList = summaryList.filter((row) => this.isTerminal(row));
    const openList = summaryList.filter((row) => !this.isTerminal(row));
    let result = await client.from(this.schema.tradesTable).upsert(summaryList, { onConflict: this.schema.summaryKeyColumn, ignoreDuplicates: true });

    if (result.error !== null) return result;

    for (const row of openList) {
      const query = client.from(this.schema.tradesTable).update(row).eq(this.schema.summaryKeyColumn, row[this.schema.summaryKeyColumn]);
      const terminalValueList = this.schema.terminalStatusList.map((status) => JSON.stringify(status)).join(',');
      result = await (terminalValueList.length === 0 ? query : query.or(`${this.schema.statusColumn}.is.null,${this.schema.statusColumn}.not.in.(${terminalValueList})`));

      if (result.error !== null) return result;
    }

    if (terminalList.length > 0) {
      result = await client.from(this.schema.tradesTable).upsert(terminalList, { onConflict: this.schema.summaryKeyColumn });
    }

    return result;
  }

  private async writeEventList(eventRowList: Record<string, unknown>[], contextLabel: string): Promise<boolean> {
    const client = this.supabaseClient;

    if (client === null) {
      return true;
    }

    const tradeIdList = eventRowList.map((row) => String(row[this.schema.event.tradeKeyColumn]));
    logger.debug({ table: this.schema.eventsTable, tradeIdList, eventCount: eventRowList.length, contextLabel, stage: 'event_batch_started' }, '[PersistentTradeJournal] Event batch write started');
    const { error, status } = await withResultRetry({
      fn: async () => client.from(this.schema.eventsTable).insert(eventRowList),
      contextLabel,
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

    if (error !== null) {
      logger.error({ table: this.schema.eventsTable, tradeIdList, eventCount: eventRowList.length, contextLabel, stage: 'event_batch_failed', status, errorCode: error.code, errorMessage: error.message }, '[PersistentTradeJournal] Event batch write failed');
    }

    return error === null;
  }

  // Persists the dirty summaries and the event batch (no spool). Returns whether the SUMMARY write ok
  // (the caller re-queues summaries on false). Events are retried then DROPPED on final failure — never
  // re-queued — so the audit-log queue stays bounded and a duplicate-key error cannot wedge the pipeline.
  private async flushToSupabase(eventRowList: Record<string, unknown>[], dirtySummaryList: Record<string, unknown>[]): Promise<boolean> {
    let isSummaryOk = true;

    if (dirtySummaryList.length > 0 && !(await this.writeSummaryList(dirtySummaryList, 'flushSummaries'))) {
      logger.error({ summaryCount: dirtySummaryList.length }, '[PersistentTradeJournal] Failed to upsert summaries after retries — re-queuing (idempotent upsert)');
      isSummaryOk = false;
    }

    if (eventRowList.length > 0 && !(await this.writeEventList(eventRowList, 'flushEvents'))) {
      logger.error({ eventCount: eventRowList.length }, '[PersistentTradeJournal] Failed to insert events after retries — dropping this batch to keep the queue bounded');
    }

    return isSummaryOk;
  }

  private async flushToSheets(dirtySummaryList: Record<string, unknown>[]): Promise<void> {
    if (dirtySummaryList.length === 0) {
      return;
    }

    const nowMs = Date.now();
    const hasTerminalTrade = dirtySummaryList.some((summary) => this.isTerminal(summary));
    const isDebounceElapsed = nowMs - this.lastSheetSyncMs >= this.sheetSyncDebounceMs;

    if (!hasTerminalTrade && !isDebounceElapsed) {
      for (const summary of dirtySummaryList) {
        this.dirtyIdSet.add(String(summary[this.schema.summaryKeyColumn]));
      }

      return;
    }

    if (this.isSheetSyncInProgress) {
      // A reconcile or full sync is writing the same sheet — re-queue and retry next tick instead of
      // interleaving two read-modify-writes (which can double-append a row that is new to the sheet).
      for (const summary of dirtySummaryList) {
        this.dirtyIdSet.add(String(summary[this.schema.summaryKeyColumn]));
      }

      return;
    }

    this.isSheetSyncInProgress = true;

    try {
      await this.writeToSheetTargets(dirtySummaryList, 'sync');
      this.lastSheetSyncMs = nowMs;
    } catch (error: unknown) {
      logger.error({ error, summaryCount: dirtySummaryList.length }, '[PersistentTradeJournal] Failed to sync summaries to Google Sheets');

      for (const summary of dirtySummaryList) {
        this.dirtyIdSet.add(String(summary[this.schema.summaryKeyColumn]));
      }
    } finally {
      this.isSheetSyncInProgress = false;
    }
  }

  private buildSheetSyncArgs(recordList: Record<string, unknown>[], sheetName?: string): SheetSyncArgs {
    return {
      sheets: this.sheetsClient as sheets_v4.Sheets,
      spreadsheetId: this.googleSheetsSpreadsheetId as string,
      columnList: this.schema.sheetColumnList,
      keyColumn: this.schema.summaryKeyColumn,
      orderColumn: this.sheetOrderColumn,
      dateColumnList: this.schema.sheetDateColumnList,
      percentColumnList: this.schema.sheetPercentColumnList,
      numberFormatByColumn: this.schema.sheetNumberFormatByColumn,
      recordList,
      sheetName,
    };
  }

  private buildUpdatedAtPatch(): Record<string, unknown> {
    if (this.schema.updatedAtColumn === null) {
      return {};
    }

    return { [this.schema.updatedAtColumn]: createDate().toISOString() };
  }

  private isTerminal(summary: Record<string, unknown>): boolean {
    return this.schema.terminalStatusList.includes(String(summary[this.schema.statusColumn]));
  }
}
