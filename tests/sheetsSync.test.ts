import { sheets_v4 } from '@googleapis/sheets';

import { ensureSheetHeader, syncRecordListToSheet, toSheetsSerialDate } from '../src/services/tradeJournal/sheetsSync';

interface SheetsMock {
  sheets: sheets_v4.Sheets;
  get: jest.Mock;
  update: jest.Mock;
  append: jest.Mock;
  batchUpdate: jest.Mock;
}

function makeSheets(existingRowList: string[][] | null, isResolvable = true): SheetsMock {
  const get = jest.fn().mockResolvedValue({ data: { values: existingRowList ?? [] } });
  const update = jest.fn().mockResolvedValue({});
  const append = jest.fn().mockResolvedValue({});
  const batchUpdate = jest.fn().mockResolvedValue({});

  const sheets = {
    spreadsheets: {
      get: jest.fn().mockResolvedValue({ data: { sheets: isResolvable ? [{ properties: { sheetId: 0, title: 'trades', index: 0 } }] : [] } }),
      values: { get, update, append, batchUpdate },
    },
  } as unknown as sheets_v4.Sheets;

  return { sheets, get, update, append, batchUpdate };
}

describe('toSheetsSerialDate', () => {
  it('maps the Unix epoch to the Sheets serial 25569', () => {
    expect(toSheetsSerialDate(0)).toBe(25569);
  });

  it('maps 2021-01-01T00:00:00Z to serial 44197 (UTC)', () => {
    expect(toSheetsSerialDate(Date.UTC(2021, 0, 1))).toBe(44197);
  });

  it('encodes UTC time-of-day as the fractional part', () => {
    expect(toSheetsSerialDate(Date.UTC(2021, 0, 1, 12))).toBe(44197.5);
  });
});

describe('ensureSheetHeader', () => {
  it('writes the header when the sheet is empty', async () => {
    const mock = makeSheets([]);

    expect(await ensureSheetHeader({ sheets: mock.sheets, spreadsheetId: 'id', columnList: ['symbol', 'id'] })).toBe(true);
    expect(mock.update).toHaveBeenCalledTimes(1);
  });

  it('rewrites the header when it drifted', async () => {
    const mock = makeSheets([['old_column']]);

    await ensureSheetHeader({ sheets: mock.sheets, spreadsheetId: 'id', columnList: ['symbol', 'id'] });
    expect(mock.update).toHaveBeenCalledTimes(1);
  });

  it('leaves a matching header untouched', async () => {
    const mock = makeSheets([['symbol', 'id']]);

    await ensureSheetHeader({ sheets: mock.sheets, spreadsheetId: 'id', columnList: ['symbol', 'id'] });
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('returns false when no sheet can be resolved', async () => {
    const mock = makeSheets([], false);

    expect(await ensureSheetHeader({ sheets: mock.sheets, spreadsheetId: 'id', columnList: ['symbol'] })).toBe(false);
    expect(mock.update).not.toHaveBeenCalled();
  });
});

describe('syncRecordListToSheet', () => {
  const columnList = ['symbol', 'entry_time', 'pnl_percent', 'id'];
  const dateColumnList = ['entry_time'];
  const percentColumnList = ['pnl_percent'];

  it('appends a row whose key is not yet in the sheet', async () => {
    const mock = makeSheets([columnList]);

    const entryTimeMs = Date.UTC(2021, 0, 1);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: entryTimeMs, pnl_percent: 12.34, id: 'A' }],
    });

    expect(mock.append).toHaveBeenCalledTimes(1);
    expect(mock.batchUpdate).not.toHaveBeenCalled();

    const appendedRow = mock.append.mock.calls[0][0].requestBody.values[0];

    expect(appendedRow).toEqual(['BTCUSDT', String(toSheetsSerialDate(entryTimeMs)), String(12.34 / 100), 'A']);
  });

  it('updates an existing row when its values changed', async () => {
    const mock = makeSheets([columnList, ['BTCUSDT', '', '', 'A']]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: 0, pnl_percent: 5, id: 'A' }],
    });

    expect(mock.batchUpdate).toHaveBeenCalledTimes(1);
    expect(mock.append).not.toHaveBeenCalled();
  });

  it('reads a range beyond column Z for a table wider than 26 columns', async () => {
    const wideColumnList = Array.from({ length: 28 }, (_, index) => `col_${index}`);
    const mock = makeSheets([wideColumnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList: wideColumnList,
      keyColumn: 'col_27',
      dateColumnList: [],
      percentColumnList: [],
      recordList: [{ col_27: 'KEY' }],
    });

    const readRange = mock.get.mock.calls[0][0].range;

    expect(readRange).toContain('A:AB');
  });
});
