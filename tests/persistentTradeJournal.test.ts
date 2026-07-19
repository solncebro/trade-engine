import { PersistentTradeJournal } from '../src/services/tradeJournal/persistentTradeJournal';
import type { TradeJournalSchema } from '../src/services/tradeJournal/persistentTradeJournal.types';

const mockTableByName = new Map<string, Record<string, unknown>[]>();
const mockControl = { failUpserts: 0, failInserts: 0, failSelects: 0 };

jest.mock('@googleapis/sheets', () => ({
  auth: { GoogleAuth: class {} },
  sheets: () => ({}),
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
    private hasReturningSelect = false;
    private readonly equalFilterList: [string, unknown][] = [];
    private inFilter: [string, unknown[]] | null = null;
    private gteFilter: [string, number] | null = null;
    private neqFilter: [string, unknown] | null = null;
    private notInFilter: [string, string] | null = null;
    private rangeFilter: [number, number] | null = null;
    private limitValue: number | null = null;

    constructor(table: string) {
      this.table = table;
    }

    upsert(rows: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }): this {
      this.op = 'upsert';
      this.payloadRowList = (Array.isArray(rows) ? rows : [rows]).map((row) => ({ ...row }));
      this.conflictKey = options?.onConflict ?? null;

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

    in(column: string, valueList: unknown[]): this {
      this.inFilter = [column, valueList];

      return this;
    }

    not(column: string, _operator: string, rawList: string): this {
      this.notInFilter = [column, rawList];

      return this;
    }

    order(): this {
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
      resolve(this.run());
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

      if (this.neqFilter !== null && row[this.neqFilter[0]] === this.neqFilter[1]) {
        return false;
      }

      if (this.notInFilter !== null) {
        const excludedList = this.notInFilter[1].replace(/[()]/g, '').split(',');

        if (excludedList.includes(String(row[this.notInFilter[0]]))) {
          return false;
        }
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
            rowList[existingIndex] = payloadRow;
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

      if (this.rangeFilter !== null) {
        selectedList = selectedList.slice(this.rangeFilter[0], this.rangeFilter[1] + 1);
      }

      if (this.limitValue !== null) {
        selectedList = selectedList.slice(0, this.limitValue);
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
