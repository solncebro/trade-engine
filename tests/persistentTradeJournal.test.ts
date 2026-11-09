import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { logger } from '../src/core/logger';
import { PersistentTradeJournal } from '../src/services/tradeJournal/persistentTradeJournal';
import type { TradeJournalSchema } from '../src/services/tradeJournal/persistentTradeJournal.types';

jest.mock('../src/core/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const mockTableByName = new Map<string, Record<string, unknown>[]>();
const mockControl = { failUpserts: 0, failInserts: 0, failSelects: 0, failSheetInitializations: 0 };
let mockBeforeWrite: ((operation: string) => Promise<void>) | null = null;

jest.mock('@googleapis/sheets', () => ({
  auth: { GoogleAuth: class {} },
  sheets: () => ({}),
}));

const sheetWriteList: {
  call: string;
  recordList: Record<string, unknown>[];
  numberFormatByColumn?: Readonly<Record<string, string>>;
  sheetName?: string;
}[] = [];
const ensuredSheetNameList: (string | undefined)[] = [];
const ensuredNumberFormatList: (Readonly<Record<string, string>> | undefined)[] = [];
const replacedSheetList: { sheetName: string; valueMatrix: (string | number)[][] }[] = [];

jest.mock('../src/services/tradeJournal/sheetsSync', () => ({
  createSheetsClient: () => ({}),
  toSheetsSerialDate: (timestampMs: number) => timestampMs,
  ensureSheetHeader: async (args: { sheetName?: string }) => {
    if (mockControl.failSheetInitializations > 0) {
      mockControl.failSheetInitializations -= 1;

      throw new Error('Internal error encountered');
    }

    ensuredSheetNameList.push(args.sheetName);

    return true;
  },
  ensureDateColumnFormat: async (args: { numberFormatByColumn?: Readonly<Record<string, string>> }) => {
    ensuredNumberFormatList.push(args.numberFormatByColumn);
  },
  syncRecordListToSheet: async (args: {
    recordList: Record<string, unknown>[];
    numberFormatByColumn?: Readonly<Record<string, string>>;
    sheetName?: string;
  }) => {
    sheetWriteList.push({ call: 'sync', recordList: args.recordList, numberFormatByColumn: args.numberFormatByColumn, sheetName: args.sheetName });
  },
  fullReplaceSheet: async (args: {
    recordList: Record<string, unknown>[];
    numberFormatByColumn?: Readonly<Record<string, string>>;
    sheetName?: string;
  }) => {
    sheetWriteList.push({ call: 'full', recordList: args.recordList, numberFormatByColumn: args.numberFormatByColumn, sheetName: args.sheetName });
  },
  replaceSheetValues: async (args: { sheetName: string; valueMatrix: (string | number)[][] }) => {
    replacedSheetList.push({ sheetName: args.sheetName, valueMatrix: args.valueMatrix });

    return true;
  },
}));

jest.mock('@supabase/supabase-js', () => {
  function rowsFor(table: string): Record<string, unknown>[] {
    if (!mockTableByName.has(table)) {
      mockTableByName.set(table, []);
    }

    return mockTableByName.get(table) as Record<string, unknown>[];
  }

  class MockBuilder {
    private readonly table: string;
    private op = 'select';
    private payloadRowList: Record<string, unknown>[] = [];
    private patch: Record<string, unknown> = {};
    private conflictKey: string | null = null;
    private ignoreDuplicates = false;
    private terminalOrFilter: [string, string[]] | null = null;
    private hasReturningSelect = false;
    private readonly equalFilterList: [string, unknown][] = [];
    private inFilter: [string, unknown[]] | null = null;
    private gteFilter: [string, number] | null = null;
    private ltFilter: [string, number] | null = null;
    private readonly orderByList: [string, boolean][] = [];
    private neqFilter: [string, unknown] | null = null;
    private notInFilter: [string, string] | null = null;
    private rangeFilter: [number, number] | null = null;
    private limitValue: number | null = null;

    constructor(table: string) {
      this.table = table;
    }

    upsert(rows: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
      this.op = 'upsert';
      this.payloadRowList = (Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row }));
      this.conflictKey = options?.onConflict ?? null;
      this.ignoreDuplicates = options?.ignoreDuplicates ?? false;

      return this;
    }

    insert(rows: Record<string, unknown> | Record<string, unknown>[]): this {
      this.op = 'insert';
      this.payloadRowList = (Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row }));

      return this;
    }

    update(patch: Record<string, unknown>): this {
      this.op = 'update';
      this.patch = patch;

      return this;
    }

    delete(): this {
      this.op = 'delete';

      return this;
    }

    select(): this {
      if (this.op === 'select') {
        return this;
      }

      this.hasReturningSelect = true;

      return this;
    }

    match(criteria: Record<string, unknown>): this {
      for (const key of Object.keys(criteria)) {
        this.equalFilterList.push([key, criteria[key]]);
      }

      return this;
    }

    eq(column: string, value: unknown): this {
      this.equalFilterList.push([column, value]);

      return this;
    }

    neq(column: string, value: unknown): this {
      this.neqFilter = [column, value];

      return this;
    }

    gte(column: string, value: number): this {
      this.gteFilter = [column, value];

      return this;
    }

    lt(column: string, value: number): this {
      this.ltFilter = [column, value];

      return this;
    }

    in(column: string, valueList: unknown[]): this {
      this.inFilter = [column, valueList];

      return this;
    }

    not(column: string, _operator: string, rawList: string): this {
      this.notInFilter = [column, rawList];

      return this;
    }

    order(column?: string, options?: { ascending: boolean }): this {
      if (column !== undefined) {
        this.orderByList.push([column, options?.ascending ?? true]);
      }

      return this;
    }

    range(from: number, to: number): this {
      this.rangeFilter = [from, to];

      return this;
    }

    limit(value: number): this {
      this.limitValue = value;

      return this;
    }

    then(resolve: (result: { data: Record<string, unknown>[] | null; error: { message: string } | null }) => void): void {
      const beforeWrite = this.op === 'upsert' || this.op === 'update' ? mockBeforeWrite : null;

      if (beforeWrite !== null) {
        void beforeWrite(this.op).then(() => resolve(this.run()));

        return;
      }

      resolve(this.run());
    }

    or(expression: string): this {
      const match = expression.match(/^(.+)\.is\.null,.*\.not\.in\.\((.*)\)$/);

      if (match === null) throw new Error(`Unexpected OR: ${expression}`);
      this.terminalOrFilter = [match[1], JSON.parse(`[${match[2]}]`) as string[]];

      return this;
    }

    private matches(row: Record<string, unknown>): boolean {
      for (const [column, value] of this.equalFilterList) {
        if (row[column] !== value) {
          return false;
        }
      }

      if (this.inFilter !== null && !this.inFilter[1].includes(row[this.inFilter[0]])) {
        return false;
      }

      if (this.gteFilter !== null && Number(row[this.gteFilter[0]]) < this.gteFilter[1]) {
        return false;
      }

      if (this.ltFilter !== null && Number(row[this.ltFilter[0]]) >= this.ltFilter[1]) {
        return false;
      }

      if (this.neqFilter !== null && row[this.neqFilter[0]] === this.neqFilter[1]) {
        return false;
      }

      if (this.notInFilter !== null) {
        const excludedList = this.notInFilter[1].replace(/[()]/g, '').split(',');

        if (excludedList.includes(String(row[this.notInFilter[0]]))) {
          return false;
        }
      }

      if (this.terminalOrFilter !== null) {
        const [column, terminalList] = this.terminalOrFilter;

        if (row[column] !== null && row[column] !== undefined && terminalList.includes(String(row[column]))) return false;
      }

      return true;
    }

    private run(): { data: Record<string, unknown>[] | null; error: { message: string } | null } {
      const rowList = rowsFor(this.table);

      if (this.op === 'upsert') {
        if (mockControl.failUpserts > 0) {
          mockControl.failUpserts -= 1;

          return { data: null, error: { message: 'upsert failed' } };
        }

        for (const payloadRow of this.payloadRowList) {
          const existingIndex = this.conflictKey === null ? -1 : rowList.findIndex((row) => row[this.conflictKey as string] === payloadRow[this.conflictKey as string]);

          if (existingIndex >= 0) {
            if (!this.ignoreDuplicates) rowList[existingIndex] = payloadRow;
          } else {
            rowList.push(payloadRow);
          }
        }

        return { data: null, error: null };
      }

      if (this.op === 'insert') {
        if (mockControl.failInserts > 0) {
          mockControl.failInserts -= 1;

          return { data: null, error: { message: 'insert failed' } };
        }

        rowList.push(...this.payloadRowList);

        return { data: null, error: null };
      }

      if (this.op === 'update') {
        const matchedList = rowList.filter((row) => this.matches(row));

        for (const row of matchedList) {
          Object.assign(row, this.patch);
        }

        return { data: this.hasReturningSelect ? matchedList.map((row) => ({ ...row })) : null, error: null };
      }

      if (this.op === 'delete') {
        const keptList = rowList.filter((row) => !this.matches(row));
        mockTableByName.set(this.table, keptList);

        return { data: null, error: null };
      }

      if (mockControl.failSelects > 0) {
        mockControl.failSelects -= 1;

        return { data: null, error: { message: 'select failed' } };
      }

      let selectedList = rowList.filter((row) => this.matches(row));

      if (this.orderByList.length > 0) {
        selectedList = [...selectedList].sort((left, right) => {
          for (const [column, ascending] of this.orderByList) {
            const comparison = String(left[column]).localeCompare(String(right[column]), undefined, { numeric: true });

            if (comparison !== 0) {
              return comparison * (ascending ? 1 : -1);
            }
          }

          return 0;
        });
      }

      if (this.rangeFilter !== null) {
        selectedList = selectedList.slice(this.rangeFilter[0], this.rangeFilter[1] + 1);
      }

      if (this.limitValue !== null) {
        selectedList = selectedList.slice(0, this.limitValue);
      }

      if (this.rangeFilter === null && this.limitValue === null) {
        selectedList = selectedList.slice(0, 1_000);
      }

      return { data: selectedList.map((row) => ({ ...row })), error: null };
    }
  }

  return {
    SupabaseClient: class {},
    createClient: () => ({ from: (table: string) => new MockBuilder(table) }),
  };
});

const TEST_SCHEMA: TradeJournalSchema = {
  tradesTable: 'test_trades',
  eventsTable: 'test_events',
  paperStateTable: 'test_paper_state',
  summaryKeyColumn: 'id',
  statusColumn: 'status',
  terminalStatusList: ['closed'],
  modeColumn: 'mode',
  reconcileTimeColumn: 'updated_at',
  reconcileTimeIsIsoString: true,
  updatedAtColumn: 'updated_at',
  paperStateKeyColumn: 'symbol',
  sheetColumnList: ['symbol', 'status', 'id'],
  sheetDateColumnList: [],
  sheetPercentColumnList: [],
  event: { tradeKeyColumn: 'trade_id', seqColumn: 'seq' },
};

const TEST_NUMBER_FORMAT_BY_COLUMN = {
  entry_price: '0.########',
  size_usd: '0.00',
  pnl_percent: '0.00%',
};

function createJournal(isSupabaseEnabled = true): PersistentTradeJournal {
  return new PersistentTradeJournal({
    schema: TEST_SCHEMA,
    supabaseUrl: isSupabaseEnabled ? 'https://example.supabase.co' : null,
    supabaseServiceKey: isSupabaseEnabled ? 'service_key' : null,
    googleSheetsSpreadsheetId: null,
    googleSheetsCredentialsPath: null,
    retryBaseDelayMs: 1,
  });
}

function tradesTable(): Record<string, unknown>[] {
  return mockTableByName.get('test_trades') ?? [];
}

function eventsTable(): Record<string, unknown>[] {
  return mockTableByName.get('test_events') ?? [];
}

describe('PersistentTradeJournal delivery diagnostics and recovery', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
    mockControl.failSheetInitializations = 0;
    sheetWriteList.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['binance', 'bybit'])('reconnects %s Sheets after a startup failure and delivers the entire history', async (exchangeName) => {
    const table = `rubber_trades_${exchangeName}`;
    mockTableByName.set(table, [{ id: 'OLD_TRADE', status: 'closed', updated_at: 1 }]);
    mockControl.failSheetInitializations = 1;
    const journal = new PersistentTradeJournal({
      schema: { ...TEST_SCHEMA, tradesTable: table },
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
    });

    try {
      await journal.initialize();
      await journal.reconcileSheetsFromSupabase({ isFull: true });

      expect(sheetWriteList).toEqual([expect.objectContaining({ call: 'sync', recordList: [expect.objectContaining({ id: 'OLD_TRADE' })] })]);
    } finally {
      await journal.shutdown();
    }
  });

  it('identifies the rejected trade and database reason without logging its payload', async () => {
    const errorLog = jest.mocked(logger.error);
    const infoLog = jest.mocked(logger.info);
    errorLog.mockClear();
    infoLog.mockClear();
    const journal = createJournal();
    mockControl.failUpserts = 99;
    journal.putSummary('REJECTED', { id: 'REJECTED', status: 'closed', accessToken: 'must-not-appear' });

    await expect(journal.flushSummaryNow('REJECTED')).resolves.toBe(false);
    expect(infoLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'summary_write_started', tradeId: 'REJECTED', table: 'test_trades' }), expect.any(String));
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ stage: 'summary_write_failed', tradeId: 'REJECTED', errorMessage: 'upsert failed' }), expect.any(String));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('must-not-appear');
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain('must-not-appear');
  });
});

describe('PersistentTradeJournal buffering', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
  });

  it('buffers a summary and event, then flushes both on shutdown', async () => {
    const journal = createJournal();

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'open' });

    expect(tradesTable()).toHaveLength(0);

    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
    expect(tradesTable()[0].status).toBe('open');
    expect(eventsTable()).toHaveLength(1);
    expect(eventsTable()[0].seq).toBe(1);
  });

  it('re-queues a summary after the DB outage exhausts retries, then persists it on the next flush', async () => {
    const journal = createJournal();
    mockControl.failUpserts = 99;

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });

    await journal.shutdown();

    expect(tradesTable()).toHaveLength(0);

    mockControl.failUpserts = 0;
    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
  });

  it('DROPS the event batch after retries are exhausted instead of re-queuing it forever (OOM guard)', async () => {
    const journal = createJournal();
    mockControl.failInserts = 99;

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'open' });

    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
    expect(eventsTable()).toHaveLength(0);

    mockControl.failInserts = 0;
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'closed' });
    await journal.shutdown();

    expect(eventsTable()).toHaveLength(1);
    expect(eventsTable()[0].event_type).toBe('closed');
  });

  it('evicts a terminal summary from RAM after it persists', async () => {
    const journal = createJournal();

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'closed', mode: 'paper' });

    await journal.shutdown();

    expect(tradesTable()[0].status).toBe('closed');
    await expect(journal.flushSummaryNow('T')).resolves.toBe(false);
  });
});

describe('PersistentTradeJournal restart durability', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
  });

  it('drops a patch after restart until the summary is rehydrated, then persists it', async () => {
    mockTableByName.set('test_trades', [{ id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' }]);

    const journal = createJournal();

    journal.patchSummary('T', { status: 'closed' });
    await expect(journal.flushSummaryNow('T')).resolves.toBe(false);
    expect(tradesTable()[0].status).toBe('open');

    await journal.rehydrateSummaries(['T']);
    journal.patchSummary('T', { status: 'closed', exit_price: 100 });

    await expect(journal.flushSummaryNow('T')).resolves.toBe(true);
    expect(tradesTable()[0].status).toBe('closed');
    expect(tradesTable()[0].exit_price).toBe(100);
  });

  it('continues the per-trade event seq counter from the DB after rehydrate', async () => {
    mockTableByName.set('test_trades', [{ id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' }]);
    mockTableByName.set('test_events', [
      { trade_id: 'T', seq: 1 },
      { trade_id: 'T', seq: 2 },
      { trade_id: 'T', seq: 3 },
    ]);

    const journal = createJournal();
    await journal.rehydrateSummaries(['T']);

    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'sl_armed' });
    await journal.shutdown();

    const armedEvent = eventsTable().find((row) => row.event_type === 'sl_armed');

    expect(armedEvent?.seq).toBe(4);
  });

  it('rehydrateSummaries is a graceful no-op when Supabase is disabled', async () => {
    const journal = createJournal(false);

    await expect(journal.rehydrateSummaries(['T'])).resolves.toBeUndefined();
  });
});

describe('PersistentTradeJournal auxiliary table access', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
  });

  it('inserts, selects and updates an auxiliary table row', async () => {
    const journal = createJournal();

    await journal.insertRow('test_rungs', { id: 'R1', ladder_id: 'L1', status: 'placed', filled_size_usd: null });

    const beforeList = await journal.selectRows({ table: 'test_rungs', match: { ladder_id: 'L1' }, limit: 1 });

    expect(beforeList).toHaveLength(1);
    expect(beforeList[0].status).toBe('placed');

    await journal.updateRows({ table: 'test_rungs', match: { id: 'R1' }, patch: { status: 'filled', filled_size_usd: 50 } });

    const afterList = await journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } });

    expect(afterList[0].status).toBe('filled');
    expect(afterList[0].filled_size_usd).toBe(50);
  });

  it('selects a half-open time range in order — the period boundary belongs to ONE period only', async () => {
    const journal = createJournal();

    await journal.insertRow('test_rungs', { id: 'R0', exit_time: 99 });
    await journal.insertRow('test_rungs', { id: 'R3', exit_time: 300 });
    await journal.insertRow('test_rungs', { id: 'R1', exit_time: 100 });
    await journal.insertRow('test_rungs', { id: 'R2', exit_time: 299 });

    const rowList = await journal.selectRows({
      table: 'test_rungs',
      match: {},
      range: { column: 'exit_time', fromValue: 100, toValue: 300 },
      order: { column: 'exit_time', ascending: true },
    });

    // 100 попадает, 300 — нет: сутки кончаются ровно там, где начинаются следующие, и сделка на
    // границе иначе посчиталась бы дважды.
    expect(rowList.map((row) => row.id)).toEqual(['R1', 'R2']);
  });

  // The sheet is read by a human top to bottom, and a trade's place in that list is WHEN IT TIED UP
  // THE MARGIN — its entry. Ordering by the row's last-touched stamp put a trade that closed earlier
  // above one that opened days before it, and a corrective rewrite reshuffled the whole sheet.
  it('writes the sheet ordered by the schema\'s sheet-order column, not by the reconcile stamp', async () => {
    sheetWriteList.length = 0;

    const journal = new PersistentTradeJournal({
      schema: { ...TEST_SCHEMA, sheetOrderColumn: 'entry_time' },
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
    });

    await journal.initialize();
    // Entered first, touched LAST — the two orders disagree, which is the whole point.
    await journal.insertRow('test_trades', { id: 'EARLY_ENTRY', entry_time: 100, updated_at: 200 });
    await journal.insertRow('test_trades', { id: 'LATE_ENTRY', entry_time: 200, updated_at: 100 });

    await journal.fullSyncToSheet();
    await journal.shutdown();

    const fullWrite = sheetWriteList.find((write) => write.call === 'full');

    expect(fullWrite?.recordList.map((record) => record.id)).toEqual(['EARLY_ENTRY', 'LATE_ENTRY']);
  });

  it('uses the summary key as a stable secondary order for equal sheet-order values', async () => {
    sheetWriteList.length = 0;

    const journal = new PersistentTradeJournal({
      schema: { ...TEST_SCHEMA, sheetOrderColumn: 'entry_time' },
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
    });

    await journal.initialize();
    await journal.insertRow('test_trades', { id: 'B', entry_time: 100, updated_at: 100 });
    await journal.insertRow('test_trades', { id: 'A', entry_time: 100, updated_at: 100 });

    await journal.fullSyncToSheet();
    await journal.shutdown();

    const fullWrite = sheetWriteList.find((write) => write.call === 'full');

    expect(fullWrite?.recordList.map((record) => record.id)).toEqual(['A', 'B']);
  });

  it('reconciles the complete history when a full reconciliation is requested', async () => {
    sheetWriteList.length = 0;

    const journal = new PersistentTradeJournal({
      schema: TEST_SCHEMA,
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
    });

    await journal.initialize();
    for (let index = 1_000; index >= 0; index--) {
      await journal.insertRow('test_trades', { id: String(index).padStart(4, '0'), updated_at: index });
    }

    await journal.reconcileSheetsFromSupabase({ isFull: true });
    await journal.shutdown();

    const syncWrite = sheetWriteList.find((write) => write.call === 'sync');

    expect(syncWrite?.recordList).toHaveLength(1_001);
    expect(syncWrite?.recordList[0].id).toBe('0000');
    expect(syncWrite?.recordList[1_000].id).toBe('1000');
  });

  describe('reconciliation window', () => {
    const DAY_MS = 86_400_000;
    const NOW_MS = 1_800_000_000_000;

    async function reconcileIdList(args?: Parameters<PersistentTradeJournal['reconcileSheetsFromSupabase']>[0]): Promise<unknown[]> {
      sheetWriteList.length = 0;
      jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      mockTableByName.set('test_trades', [
        { id: 'MONTH_OLD', status: 'closed', updated_at: NOW_MS - 30 * DAY_MS },
        { id: 'EIGHT_DAYS', status: 'closed', updated_at: NOW_MS - 8 * DAY_MS },
        { id: 'TWO_DAYS', status: 'closed', updated_at: NOW_MS - 2 * DAY_MS },
        { id: 'ONE_HOUR', status: 'open', updated_at: NOW_MS - 3_600_000 },
      ]);
      const journal = new PersistentTradeJournal({
        schema: { ...TEST_SCHEMA, reconcileTimeIsIsoString: false },
        supabaseUrl: 'https://example.supabase.co',
        supabaseServiceKey: 'service_key',
        googleSheetsSpreadsheetId: 'sheet-1',
        googleSheetsCredentialsPath: '/tmp/credentials.json',
        retryBaseDelayMs: 1,
      });

      await journal.initialize();
      await journal.reconcileSheetsFromSupabase(args);
      await journal.shutdown();

      return sheetWriteList.filter((write) => write.call === 'sync').flatMap((write) => write.recordList.map((record) => record.id));
    }

    it('reads only the last seven days when called without arguments', async () => {
      expect(await reconcileIdList()).toEqual(['TWO_DAYS', 'ONE_HOUR']);
    });

    it('reads rows from the given start time on', async () => {
      expect(await reconcileIdList({ sinceMs: NOW_MS - 10 * DAY_MS })).toEqual(['EIGHT_DAYS', 'TWO_DAYS', 'ONE_HOUR']);
    });

    it('reads the whole table for a full reconciliation', async () => {
      expect(await reconcileIdList({ isFull: true })).toEqual(['MONTH_OLD', 'EIGHT_DAYS', 'TWO_DAYS', 'ONE_HOUR']);
    });
  });

  it('falls back to the reconcile stamp when no sheet-order column is configured', async () => {
    sheetWriteList.length = 0;

    const journal = new PersistentTradeJournal({
      schema: TEST_SCHEMA,
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
    });

    await journal.initialize();
    // Entry order and last-touched order disagree, so the two columns cannot both be right here.
    await journal.insertRow('test_trades', { id: 'EARLY_ENTRY', entry_time: 100, updated_at: 200 });
    await journal.insertRow('test_trades', { id: 'LATE_ENTRY', entry_time: 200, updated_at: 100 });

    await journal.fullSyncToSheet();
    await journal.shutdown();

    const fullWrite = sheetWriteList.find((write) => write.call === 'full');

    expect(fullWrite?.recordList.map((record) => record.id)).toEqual(['LATE_ENTRY', 'EARLY_ENTRY']);
  });

  it('leaves the query untouched when neither range nor order is asked for', async () => {
    const journal = createJournal();

    await journal.insertRow('test_rungs', { id: 'R1', exit_time: 1 });

    await expect(journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } })).resolves.toHaveLength(1);
  });

  it('honours the notEqual guard on updateRows', async () => {
    const journal = createJournal();

    await journal.insertRow('test_rungs', { id: 'R1', ladder_id: 'L1', target_price: 100, status: 'filled' });

    await journal.updateRows({
      table: 'test_rungs',
      match: { ladder_id: 'L1', target_price: 100 },
      patch: { status: 'canceled' },
      notEqual: { column: 'status', value: 'filled' },
    });

    const rowList = await journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } });

    expect(rowList[0].status).toBe('filled');
  });
});

describe('PersistentTradeJournal sheet number formats', () => {
  beforeEach(() => {
    mockTableByName.clear();
    sheetWriteList.length = 0;
    ensuredNumberFormatList.length = 0;
  });

  function createFormattedJournal(): PersistentTradeJournal {
    return new PersistentTradeJournal({
      schema: { ...TEST_SCHEMA, sheetNumberFormatByColumn: TEST_NUMBER_FORMAT_BY_COLUMN },
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      liveSheetMirror: true,
      sheetSyncDebounceMs: 0,
      retryBaseDelayMs: 1,
    });
  }

  it('passes configured number formats during sheet initialization', async () => {
    const journal = createFormattedJournal();

    await journal.initialize();
    await journal.shutdown();

    expect(ensuredNumberFormatList).toEqual([TEST_NUMBER_FORMAT_BY_COLUMN]);
  });

  it('passes configured number formats to the live sheet sync', async () => {
    const journal = createFormattedJournal();

    await journal.initialize();
    journal.putSummary('T', { id: 'T', status: 'open' });
    await journal.shutdown();

    expect(sheetWriteList.find((write) => write.call === 'sync')?.numberFormatByColumn).toBe(TEST_NUMBER_FORMAT_BY_COLUMN);
  });

  it('passes configured number formats to the full sheet sync', async () => {
    const journal = createFormattedJournal();

    await journal.initialize();
    await journal.insertRow('test_trades', { id: 'T', status: 'open', updated_at: 1 });
    await journal.fullSyncToSheet();
    await journal.shutdown();

    expect(sheetWriteList.find((write) => write.call === 'full')?.numberFormatByColumn).toBe(TEST_NUMBER_FORMAT_BY_COLUMN);
  });
});

describe('PersistentTradeJournal paper state', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
  });

  it('saves, loads and removes paper state by key', async () => {
    const journal = createJournal();

    await journal.savePaperState({ symbol: 'BTCUSDT', entry_price: 100, size_usd: 50 });

    const loadedList = await journal.loadPaperStateList();

    expect(loadedList).toHaveLength(1);
    expect(loadedList[0].symbol).toBe('BTCUSDT');

    await journal.removePaperState('BTCUSDT');

    await expect(journal.loadPaperStateList()).resolves.toHaveLength(0);
  });

  it('reports whether paper-state writes reached the database', async () => {
    const journal = createJournal();

    await expect(journal.savePaperStateConfirmed({ symbol: 'BTCUSDT' })).resolves.toBe(true);
    await expect(journal.removePaperStateConfirmed('BTCUSDT')).resolves.toBe(true);
  });

  it('reports unconfirmed paper-state writes when the database is disabled', async () => {
    const journal = createJournal(false);

    await expect(journal.savePaperStateConfirmed({ symbol: 'BTCUSDT' })).resolves.toBe(false);
    await expect(journal.removePaperStateConfirmed('BTCUSDT')).resolves.toBe(false);
    await expect(journal.savePaperState({ symbol: 'BTCUSDT' })).resolves.toBeUndefined();
    await expect(journal.removePaperState('BTCUSDT')).resolves.toBeUndefined();
  });
});

describe('PersistentTradeJournal one-shot retry', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
  });

  it('retries a failing auxiliary-table write across a brief outage and eventually persists', async () => {
    const journal = createJournal();
    mockControl.failInserts = 2;

    await journal.insertRow('test_rungs', { id: 'R1', ladder_id: 'L1', status: 'placed' });

    await expect(journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } })).resolves.toHaveLength(1);
  });

  it('retries a failing paper-state save and eventually persists', async () => {
    const journal = createJournal();
    mockControl.failUpserts = 1;

    await journal.savePaperState({ symbol: 'BTCUSDT', size_usd: 50 });

    await expect(journal.loadPaperStateList()).resolves.toHaveLength(1);
  });

  it('THROWS on a read failure so the caller can tell "empty" from "could not read" (selectRows)', async () => {
    const journal = createJournal();
    mockControl.failSelects = 99;

    await expect(journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } })).rejects.toThrow();
  });

  it('THROWS on a read failure for loadPaperStateList (never a false-empty)', async () => {
    const journal = createJournal();
    mockControl.failSelects = 99;

    await expect(journal.loadPaperStateList()).rejects.toThrow();
  });

  it('does not throw when a one-shot write keeps failing past every retry', async () => {
    const journal = createJournal();
    mockControl.failInserts = 99;

    await expect(journal.insertRow('test_rungs', { id: 'R1' })).resolves.toBeUndefined();

    mockControl.failInserts = 0;

    await expect(journal.selectRows({ table: 'test_rungs', match: { id: 'R1' } })).resolves.toHaveLength(0);
  });
});

describe('PersistentTradeJournal on-disk spool', () => {
  let spoolDirectory: string;
  let spoolFilePath: string;

  function createSpooledJournal(): PersistentTradeJournal {
    return new PersistentTradeJournal({
      schema: TEST_SCHEMA,
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: null,
      googleSheetsCredentialsPath: null,
      retryBaseDelayMs: 1,
      spoolFilePath,
    });
  }

  function readSpoolLineList(): Record<string, unknown>[] {
    if (!existsSync(spoolFilePath)) {
      return [];
    }

    return readFileSync(spoolFilePath, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
    spoolDirectory = mkdtempSync(path.join(tmpdir(), 'journal-spool-'));
    spoolFilePath = path.join(spoolDirectory, 'nested', 'journal.jsonl');
  });

  afterEach(() => {
    rmSync(spoolDirectory, { recursive: true, force: true });
  });

  it('keeps a failed summary AND its events on disk instead of dropping them, then replays on the next successful flush', async () => {
    const journal = createSpooledJournal();
    await journal.initialize();
    mockControl.failUpserts = 99;
    mockControl.failInserts = 99;

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'open' });
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'sl_armed' });
    await journal.shutdown();

    expect(tradesTable()).toHaveLength(0);
    expect(eventsTable()).toHaveLength(0);
    expect(readSpoolLineList().map((line) => line.kind)).toEqual(['summary', 'event', 'event']);

    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
    expect(eventsTable().map((row) => [row.event_type, row.seq])).toEqual([['open', 1], ['sl_armed', 2]]);
    expect(existsSync(spoolFilePath)).toBe(false);
  });

  it('survives a restart: a new process replays the spool on initialize()', async () => {
    const firstRun = createSpooledJournal();
    await firstRun.initialize();
    mockControl.failUpserts = 99;
    mockControl.failInserts = 99;

    firstRun.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'closed', mode: 'paper' });
    firstRun.enqueueEvent('T', { trade_id: 'T', event_type: 'closed' });
    await firstRun.shutdown();

    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;

    const secondRun = createSpooledJournal();
    await secondRun.initialize();

    expect(tradesTable()[0].status).toBe('closed');
    expect(eventsTable()).toHaveLength(1);
    expect(existsSync(spoolFilePath)).toBe(false);

    await secondRun.shutdown();
  });

  it('does not duplicate an event whose insert landed but whose answer was lost', async () => {
    mockTableByName.set('test_events', [{ trade_id: 'T', seq: 1, event_type: 'open' }]);
    spoolFilePath = path.join(spoolDirectory, 'journal.jsonl');
    writeFileSync(spoolFilePath, [
      JSON.stringify({ kind: 'event', tradeKey: 'T', row: { trade_id: 'T', seq: 1, event_type: 'open' } }),
      JSON.stringify({ kind: 'event', tradeKey: 'T', row: { trade_id: 'T', seq: 2, event_type: 'closed' } }),
      '',
    ].join('\n'));

    const journal = createSpooledJournal();
    await journal.initialize();

    expect(eventsTable().map((row) => row.seq)).toEqual([1, 2]);
    await journal.shutdown();
  });

  it('skips a torn last line left by a crash mid-write and replays the rest', async () => {
    spoolFilePath = path.join(spoolDirectory, 'journal.jsonl');
    writeFileSync(spoolFilePath, `${JSON.stringify({ kind: 'summary', key: 'T', row: { id: 'T', status: 'open' } })}\n{"kind":"eve`);

    const journal = createSpooledJournal();
    await journal.initialize();

    expect(tradesTable()).toHaveLength(1);
    expect(existsSync(spoolFilePath)).toBe(false);
    await journal.shutdown();
  });

  it('continues the event seq from the spool when the database is still down at startup', async () => {
    spoolFilePath = path.join(spoolDirectory, 'journal.jsonl');
    writeFileSync(spoolFilePath, `${JSON.stringify({ kind: 'event', tradeKey: 'T', row: { trade_id: 'T', seq: 2, event_type: 'sl_armed' } })}\n`);
    mockControl.failInserts = 99;
    mockControl.failSelects = 99;

    const journal = createSpooledJournal();
    await journal.initialize();

    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'closed' });
    await journal.shutdown();

    expect(readSpoolLineList().map((line) => (line.row as Record<string, unknown>).seq)).toEqual([2, 3]);

    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
    await journal.shutdown();

    expect(eventsTable().map((row) => row.seq)).toEqual([2, 3]);
  });

  // The spool copy is what the database refused; a later patch in RAM is newer and must win.
  it('never writes an older spooled summary over a newer one in RAM', async () => {
    const journal = createSpooledJournal();
    await journal.initialize();
    mockControl.failUpserts = 99;

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });
    await journal.shutdown();

    mockControl.failUpserts = 0;
    journal.patchSummary('T', { status: 'tp_hit' });
    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
    expect(tradesTable()[0].status).toBe('tp_hit');
  });

  it('rehydrates a resumed trade from the spool when its newest version never reached the database', async () => {
    mockTableByName.set('test_trades', [{ id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' }]);
    spoolFilePath = path.join(spoolDirectory, 'journal.jsonl');
    writeFileSync(spoolFilePath, `${JSON.stringify({ kind: 'summary', key: 'T', row: { id: 'T', symbol: 'BTCUSDT', status: 'tp_hit', mode: 'paper' } })}\n`);
    mockControl.failUpserts = 99;

    const journal = createSpooledJournal();
    await journal.initialize();
    await journal.rehydrateSummaries(['T']);

    expect(journal.getSummary('T')?.status).toBe('tp_hit');

    mockControl.failUpserts = 0;
    await journal.shutdown();

    expect(tradesTable()[0].status).toBe('tp_hit');
  });

  it('keeps only the events on disk when the summaries replayed but the events did not', async () => {
    const journal = createSpooledJournal();
    await journal.initialize();
    mockControl.failUpserts = 99;
    mockControl.failInserts = 99;

    journal.putSummary('T', { id: 'T', symbol: 'BTCUSDT', status: 'open', mode: 'paper' });
    journal.enqueueEvent('T', { trade_id: 'T', event_type: 'open' });
    await journal.shutdown();

    mockControl.failUpserts = 0;
    await journal.shutdown();

    expect(tradesTable()).toHaveLength(1);
    expect(readSpoolLineList().map((line) => line.kind)).toEqual(['event']);

    mockControl.failInserts = 0;
    await journal.shutdown();

    expect(eventsTable()).toHaveLength(1);
    expect(existsSync(spoolFilePath)).toBe(false);
  });

  it('exposes its Supabase client for Storage uploads', () => {
    expect(createSpooledJournal().getSupabaseClient()).not.toBeNull();
    expect(createJournal(false).getSupabaseClient()).toBeNull();
  });
});

describe('PersistentTradeJournal named sheet targets', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
    sheetWriteList.length = 0;
    ensuredSheetNameList.length = 0;
    replacedSheetList.length = 0;
  });

  function createTargetedJournal(): PersistentTradeJournal {
    return new PersistentTradeJournal({
      schema: TEST_SCHEMA,
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
      liveSheetMirror: true,
      sheetTargetList: [
        { sheetName: 'Сделки', shouldIncludeRow: () => true },
        { sheetName: 'Иван', shouldIncludeRow: (row) => row.trader === 'Иван' },
        { sheetName: 'Пётр', shouldIncludeRow: (row) => row.trader === 'Пётр' },
      ],
    });
  }

  it('prepares every target sheet at startup', async () => {
    const journal = createTargetedJournal();
    await journal.initialize();
    await journal.shutdown();

    expect(ensuredSheetNameList).toEqual(['Сделки', 'Иван', 'Пётр']);
  });

  it('mirrors each row into the main sheet and its own trader sheet only', async () => {
    const journal = createTargetedJournal();
    await journal.initialize();

    journal.putSummary('A', { id: 'A', trader: 'Иван', status: 'closed' });
    await journal.shutdown();

    expect(sheetWriteList.map((write) => [write.sheetName, write.recordList.map((row) => row.id)])).toEqual([
      ['Сделки', ['A']],
      ['Иван', ['A']],
    ]);
  });

  it('full sync rewrites every target, an empty one included', async () => {
    const journal = createTargetedJournal();
    await journal.initialize();
    await journal.insertRow('test_trades', { id: 'A', trader: 'Иван', updated_at: 1 });

    await journal.fullSyncToSheet();
    await journal.shutdown();

    expect(sheetWriteList.filter((write) => write.call === 'full').map((write) => [write.sheetName, write.recordList.length])).toEqual([
      ['Сделки', 1],
      ['Иван', 1],
      ['Пётр', 0],
    ]);
  });

  it('writes a summary sheet through replaceNamedSheet', async () => {
    const journal = createTargetedJournal();
    await journal.initialize();

    await expect(journal.replaceNamedSheet('Сводка', [['Трейдер', 'Сделок'], ['Иван', 1]])).resolves.toBe(true);
    await journal.shutdown();

    expect(replacedSheetList).toEqual([{ sheetName: 'Сводка', valueMatrix: [['Трейдер', 'Сделок'], ['Иван', 1]] }]);
  });

  it('replaceNamedSheet reports false when the Sheets channel is off', async () => {
    await expect(createJournal().replaceNamedSheet('Сводка', [['x']])).resolves.toBe(false);
  });

  it('keeps the first-sheet behaviour when no targets are configured', async () => {
    const journal = new PersistentTradeJournal({
      schema: TEST_SCHEMA,
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceKey: 'service_key',
      googleSheetsSpreadsheetId: 'sheet-1',
      googleSheetsCredentialsPath: '/tmp/credentials.json',
      retryBaseDelayMs: 1,
      liveSheetMirror: true,
    });
    await journal.initialize();

    journal.putSummary('A', { id: 'A', status: 'closed' });
    await journal.shutdown();

    expect(ensuredSheetNameList).toEqual([undefined]);
    expect(sheetWriteList.map((write) => write.sheetName)).toEqual([undefined]);
  });
});


describe('PersistentTradeJournal monotonic summary persistence', () => {
  beforeEach(() => {
    mockTableByName.clear();
    mockControl.failUpserts = 0;
    mockControl.failInserts = 0;
    mockControl.failSelects = 0;
    mockBeforeWrite = null;
  });

  afterEach(() => { mockBeforeWrite = null; });

  it.each(['upsert', 'update'])('keeps a closed trade when another instance completes a delayed open %s', async (delayedOperation) => {
    let release = () => {};
    let announce = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announce = resolve; });
    let delayed = false;
    mockBeforeWrite = async (operation) => {
      if (operation !== delayedOperation || delayed) return;
      delayed = true;
      announce();
      await gate;
    };
    const oldJournal = createJournal();
    oldJournal.putSummary('stable-id', { id: 'stable-id', status: 'open', size_usd: 9702 });
    const oldWrite = oldJournal.flushSummaryNow('stable-id');
    await started;
    const newJournal = createJournal();
    newJournal.putSummary('stable-id', { id: 'stable-id', status: 'closed', size_usd: 10000, pnl_usd: -1535 });

    try {
      await expect(newJournal.flushSummaryNow('stable-id')).resolves.toBe(true);
      release();
      await expect(oldWrite).resolves.toBe(true);
      expect(tradesTable()).toEqual([{ id: 'stable-id', status: 'closed', size_usd: 10000, pnl_usd: -1535 }]);
    } finally {
      release();
      await oldWrite;
    }
  });

  it('serializes an immediate terminal write behind an unfinished batch flush', async () => {
    let release = () => {};
    let announce = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { announce = resolve; });
    let writeCount = 0;
    mockBeforeWrite = async () => {
      writeCount += 1;

      if (writeCount !== 1) return;
      announce();
      await gate;
    };
    const journal = createJournal();
    journal.putSummary('stable-id', { id: 'stable-id', status: 'open' });
    const batch = journal.shutdown();
    await started;
    journal.patchSummary('stable-id', { status: 'closed' });
    const close = journal.flushSummaryNow('stable-id');

    try {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      expect(writeCount).toBe(1);
      release();
      await batch;
      await expect(close).resolves.toBe(true);
      expect(tradesTable()[0].status).toBe('closed');
    } finally {
      release();
      await Promise.allSettled([batch, close]);
    }
  });

  it('updates nonterminal rows with null status while preserving a confirmed terminal row', async () => {
    mockTableByName.set('test_trades', [{ id: 'unknown', status: null }, { id: 'terminal', status: 'closed', pnl_usd: 42 }]);
    const journal = createJournal();
    journal.putSummary('unknown', { id: 'unknown', status: 'open' });
    journal.putSummary('terminal', { id: 'terminal', status: 'open', pnl_usd: null });
    await journal.shutdown();

    expect(tradesTable()).toEqual([{ id: 'unknown', status: 'open' }, { id: 'terminal', status: 'closed', pnl_usd: 42 }]);
  });

  it('still allows an intentional correction of terminal accounting fields', async () => {
    mockTableByName.set('test_trades', [{ id: 'terminal', status: 'closed', funding_usd: null }]);
    const journal = createJournal();
    await journal.rehydrateSummaries(['terminal']);
    journal.patchSummary('terminal', { funding_usd: 2 });
    await expect(journal.flushSummaryNow('terminal')).resolves.toBe(true);
    expect(tradesTable()[0]).toEqual(expect.objectContaining({ status: 'closed', funding_usd: 2 }));
  });
});
