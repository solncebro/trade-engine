import { sheets_v4 } from '@googleapis/sheets';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

import type {
  JournalSelectRowsArgs,
  JournalUpdateRowsArgs,
  MarkOrphanedArgs,
  PersistentTradeJournalConfig,
  TradeJournalSchema,
} from './persistentTradeJournal.types';
import {
  createSheetsClient,
  ensureDateColumnFormat,
  ensureSheetHeader,
  fullReplaceSheet,
  syncRecordListToSheet,
} from './sheetsSync';
import type { SheetSyncArgs } from './sheetsSync';

import { logger } from '../../core/logger';
import { withResultRetry } from '../../core/withRetryOn429';
import { createDate } from '../../utils/date.utils';

const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
const DEFAULT_SHEET_SYNC_DEBOUNCE_MS = 30_000;
const SUPABASE_PAGE_SIZE = 1_000;
const MS_PER_DAY = 86_400_000;
const SUPABASE_MAX_ATTEMPTS = 3;
const SUPABASE_RETRY_BASE_DELAY_MS = 500;

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
  private readonly summaryById: Map<string, Record<string, unknown>> = new Map();
  private readonly seqById: Map<string, number> = new Map();
  private readonly dirtyIdSet: Set<string> = new Set();
  private eventQueueList: Record<string, unknown>[] = [];
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

    if (config.supabaseUrl !== null && config.supabaseServiceKey !== null) {
      this.supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceKey);
      this.isSupabaseEnabled = true;
    }

    if (this.googleSheetsSpreadsheetId !== null && this.googleSheetsCredentialsPath !== null) {
      this.isSheetsEnabled = true;
    }
  }

  async initialize(): Promise<void> {
    if (this.isSheetsEnabled && this.googleSheetsCredentialsPath !== null && this.googleSheetsSpreadsheetId !== null) {
      try {
        this.sheetsClient = createSheetsClient(this.googleSheetsCredentialsPath);

        await ensureSheetHeader({ sheets: this.sheetsClient, spreadsheetId: this.googleSheetsSpreadsheetId, columnList: this.schema.sheetColumnList });
        await ensureDateColumnFormat({
          sheets: this.sheetsClient,
          spreadsheetId: this.googleSheetsSpreadsheetId,
          columnList: this.schema.sheetColumnList,
          dateColumnList: this.schema.sheetDateColumnList,
        });
      } catch (error: unknown) {
        logger.error({ error }, '[PersistentTradeJournal] Failed to initialize Google Sheets — disabling Sheets channel');
        this.isSheetsEnabled = false;
        this.sheetsClient = null;
      }
    }

    if (this.isEnabled()) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((error: unknown) => {
          logger.error({ error }, '[PersistentTradeJournal] Flush tick failed');
        });
      }, this.flushIntervalMs).unref();
    }

    logger.info(
      { isSupabaseEnabled: this.isSupabaseEnabled, isSheetsEnabled: this.isSheetsEnabled },
      `[PersistentTradeJournal] Initialized (supabase: ${this.isSupabaseEnabled}, sheets: ${this.isSheetsEnabled})`,
    );
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

    this.eventQueueList.push(row);
  }

  // Immediately persist a single summary, bypassing the batched flush. Used before dropping a closed
  // setup's resume state so the terminal status is guaranteed in the DB first. Returns false when there
  // is no summary to persist — the caller must then KEEP the resume state so the trade replays.
  async flushSummaryNow(id: string): Promise<boolean> {
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return true;
    }

    const summary = this.summaryById.get(id);

    if (summary === undefined) {
      logger.warn({ id }, '[PersistentTradeJournal] flushSummaryNow — no in-memory summary; keeping resume state so the trade replays');

      return false;
    }

    const client = this.supabaseClient;
    const { error } = await withResultRetry({
      fn: async () => client.from(this.schema.tradesTable).upsert(summary, { onConflict: this.schema.summaryKeyColumn }),
      contextLabel: 'flushSummaryNow',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });

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
      logger.warn({ error }, '[PersistentTradeJournal] Final flush on shutdown failed — some journal rows may be lost');
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

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = String(row[this.schema.summaryKeyColumn]);
      this.summaryById.set(id, row);
      loadedIdList.push(id);
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
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return;
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
    if (!this.isSupabaseEnabled || this.supabaseClient === null) {
      return;
    }

    const client = this.supabaseClient;

    await withResultRetry({
      fn: async () => client.from(this.schema.paperStateTable).delete().eq(this.schema.paperStateKeyColumn, keyValue),
      contextLabel: 'removePaperState',
      maxRetries: SUPABASE_MAX_ATTEMPTS,
      baseDelayMs: this.retryBaseDelayMs,
    });
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
        const filtered = client.from(args.table).select('*').match(args.match);
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

  // Periodic reconcile: pull trades from Supabase (the source of truth) for the last `lookbackDays` and
  // re-push them to Sheets through the same sync path. Fixes closed trades whose final state never
  // reached Sheets and were already evicted from RAM.
  async reconcileSheetsFromSupabase(lookbackDays: number): Promise<void> {
    if (!this.isSupabaseEnabled || !this.isSheetsEnabled || this.supabaseClient === null || this.sheetsClient === null || this.googleSheetsSpreadsheetId === null) {
      return;
    }

    if (this.isSheetSyncInProgress) {
      logger.warn('[PersistentTradeJournal] Sheets reconcile skipped — another sheet sync is in progress');

      return;
    }

    this.isSheetSyncInProgress = true;

    try {
      const cutoffMs = Date.now() - lookbackDays * MS_PER_DAY;
      const cutoff = this.schema.reconcileTimeIsIsoString ? createDate(cutoffMs).toISOString() : cutoffMs;
      const { data, error } = await this.supabaseClient
        .from(this.schema.tradesTable)
        .select('*')
        .gte(this.schema.reconcileTimeColumn, cutoff)
        .order(this.sheetOrderColumn, { ascending: true });

      if (error !== null) {
        throw new Error(error.message);
      }

      const rowList = (data ?? []) as Record<string, unknown>[];

      if (rowList.length === 0) {
        logger.info({ lookbackDays }, `[PersistentTradeJournal] Sheets reconcile — 0 trade(s) in the last ${lookbackDays} day(s)`);

        return;
      }

      await syncRecordListToSheet(this.buildSheetSyncArgs(rowList));

      logger.info({ tradeCount: rowList.length, lookbackDays }, `[PersistentTradeJournal] Sheets reconcile completed — ${rowList.length} trade(s) pushed`);
    } catch (error: unknown) {
      logger.error({ error, lookbackDays }, '[PersistentTradeJournal] Sheets reconcile failed');
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
      const rowList = await this.fetchAllSummaryRows();

      await fullReplaceSheet(this.buildSheetSyncArgs(rowList));

      logger.info({ recordCount: rowList.length }, `[PersistentTradeJournal] Full sync completed — ${rowList.length} record(s) written`);

      return { recordCount: rowList.length };
    } finally {
      this.isSheetSyncInProgress = false;
    }
  }

  /** The column the sheet is ordered by. A sheet is read top to bottom by a person, so the order has to
   *  be the one that means something to them; for a trade journal that is when the trade went on, not
   *  when its row was last touched. Both sheet paths — the periodic reconcile and the full rewrite — use
   *  this, so a rewrite can never reshuffle the sheet into a different order than the bot appends in. */
  private get sheetOrderColumn(): string {
    return this.schema.sheetOrderColumn ?? this.schema.reconcileTimeColumn;
  }

  private async fetchAllSummaryRows(): Promise<Record<string, unknown>[]> {
    if (this.supabaseClient === null) {
      return [];
    }

    const allRowList: Record<string, unknown>[] = [];
    let fromIndex = 0;

    for (;;) {
      const { data, error } = await this.supabaseClient
        .from(this.schema.tradesTable)
        .select('*')
        .order(this.sheetOrderColumn, { ascending: true })
        .range(fromIndex, fromIndex + SUPABASE_PAGE_SIZE - 1);

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

  private async flush(): Promise<void> {
    if (this.eventQueueList.length === 0 && this.dirtyIdSet.size === 0) {
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

    const isSummaryOk = this.isSupabaseEnabled
      ? await this.flushToSupabase(eventQueueSnapshotList, dirtySummaryList)
      : true;

    // DB outage: re-queue ONLY the summaries — their upsert is idempotent (onConflict on the key), so a
    // re-write after a lost ack is safe. Events are NOT re-queued here: they carry fixed primary keys and
    // a plain re-queue would loop forever on a duplicate-key error and grow the queue without bound, so
    // flushToSupabase retries then DROPS the event batch on final failure (as the original journal did).
    if (!isSummaryOk) {
      for (const id of dirtyIdSnapshotList) {
        this.dirtyIdSet.add(id);
      }
    }

    if (this.isSheetsEnabled && this.liveSheetMirror) {
      await this.flushToSheets(dirtySummaryList);
    }

    if (!isSummaryOk) {
      return;
    }

    // Evict terminal summaries that persisted and are not pending again (e.g. re-queued by the Sheets
    // mirror). Keeping them would leak memory for every closed trade.
    for (const id of dirtyIdSnapshotList) {
      const summary = this.summaryById.get(id);

      if (summary !== undefined && this.isTerminal(summary) && !this.dirtyIdSet.has(id)) {
        this.summaryById.delete(id);
        this.seqById.delete(id);
      }
    }
  }

  // Persists the dirty summaries and the event batch. Returns whether the SUMMARY write ok (the caller
  // re-queues summaries on false). Events are retried then DROPPED on final failure — never re-queued —
  // so the audit-log queue stays bounded and a duplicate-key error cannot wedge the pipeline forever.
  private async flushToSupabase(eventQueueSnapshotList: Record<string, unknown>[], dirtySummaryList: Record<string, unknown>[]): Promise<boolean> {
    const client = this.supabaseClient;

    if (client === null) {
      return true;
    }

    let isSummaryOk = true;

    if (dirtySummaryList.length > 0) {
      const { error } = await withResultRetry({
        fn: async () => client.from(this.schema.tradesTable).upsert(dirtySummaryList, { onConflict: this.schema.summaryKeyColumn }),
        contextLabel: 'flushSummaries',
        maxRetries: SUPABASE_MAX_ATTEMPTS,
        baseDelayMs: this.retryBaseDelayMs,
      })

      if (error !== null) {
        logger.error({ error, summaryCount: dirtySummaryList.length }, '[PersistentTradeJournal] Failed to upsert summaries after retries — re-queuing (idempotent upsert)');
        isSummaryOk = false;
      }
    }

    if (eventQueueSnapshotList.length > 0) {
      const { error } = await withResultRetry({
        fn: async () => client.from(this.schema.eventsTable).insert(eventQueueSnapshotList),
        contextLabel: 'flushEvents',
        maxRetries: SUPABASE_MAX_ATTEMPTS,
        baseDelayMs: this.retryBaseDelayMs,
      })

      if (error !== null) {
        logger.error({ error, eventCount: eventQueueSnapshotList.length }, '[PersistentTradeJournal] Failed to insert events after retries — dropping this batch to keep the queue bounded');
      }
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
      await syncRecordListToSheet(this.buildSheetSyncArgs(dirtySummaryList));
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

  private buildSheetSyncArgs(recordList: Record<string, unknown>[]): SheetSyncArgs {
    return {
      sheets: this.sheetsClient as sheets_v4.Sheets,
      spreadsheetId: this.googleSheetsSpreadsheetId as string,
      columnList: this.schema.sheetColumnList,
      keyColumn: this.schema.summaryKeyColumn,
      dateColumnList: this.schema.sheetDateColumnList,
      percentColumnList: this.schema.sheetPercentColumnList,
      recordList,
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
