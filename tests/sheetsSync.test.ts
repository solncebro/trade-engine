import { sheets_v4 } from '@googleapis/sheets';

import { ensureSheetHeader, fullReplaceSheet, syncRecordListToSheet, toSheetsSerialDate } from '../src/services/tradeJournal/sheetsSync';

interface SheetsMock {
  sheets: sheets_v4.Sheets;
  get: jest.Mock;
  update: jest.Mock;
  append: jest.Mock;
  batchUpdate: jest.Mock;
  clear: jest.Mock;
  formatBatchUpdate: jest.Mock;
}

function makeSheets(existingRowList: string[][] | null, isResolvable = true): SheetsMock {
  const get = jest.fn().mockResolvedValue({ data: { values: existingRowList ?? [] } });
  const update = jest.fn().mockResolvedValue({});
  const append = jest.fn().mockResolvedValue({});
  const batchUpdate = jest.fn().mockResolvedValue({});
  const clear = jest.fn().mockResolvedValue({});
  const formatBatchUpdate = jest.fn().mockResolvedValue({});

  const sheets = {
    spreadsheets: {
      get: jest.fn().mockResolvedValue({ data: { sheets: isResolvable ? [{ properties: { sheetId: 0, title: 'trades', index: 0 } }] : [] } }),
      batchUpdate: formatBatchUpdate,
      values: { get, update, append, batchUpdate, clear },
    },
  } as unknown as sheets_v4.Sheets;

  return { sheets, get, update, append, batchUpdate, clear, formatBatchUpdate };
}

function firstNumberFormat(formatBatchUpdate: jest.Mock): sheets_v4.Schema$Request {
  return formatBatchUpdate.mock.calls[0][0].requestBody.requests[0] as sheets_v4.Schema$Request;
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

    // Numbers go in as numbers, NOT as text: with USER_ENTERED a "46233.04" string is parsed in the
    // spreadsheet's own locale, and a comma-decimal locale (ru_RU) turns it into a text cell.
    expect(appendedRow).toEqual(['BTCUSDT', toSheetsSerialDate(entryTimeMs), 0.1234, 'A']);
    expect(typeof appendedRow[1]).toBe('number');
    expect(typeof appendedRow[2]).toBe('number');
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

  // Rows arriving through append land as freshly inserted rows and do NOT carry the date format applied
  // to the column at startup — without this pass the sheet shows a bare serial number instead of a date.
  it('re-applies the date format after appending rows', async () => {
    const mock = makeSheets([columnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: Date.UTC(2021, 0, 1), pnl_percent: 1, id: 'A' }],
    });

    expect(mock.formatBatchUpdate).toHaveBeenCalledTimes(1);

    const request = firstNumberFormat(mock.formatBatchUpdate);

    expect(request.repeatCell?.range).toEqual({ sheetId: 0, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 });
    expect(request.repeatCell?.cell?.userEnteredFormat?.numberFormat?.type).toBe('DATE_TIME');
  });

  it('leaves the date format alone when nothing was appended', async () => {
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

    expect(mock.formatBatchUpdate).not.toHaveBeenCalled();
  });

  // -2.83 / 100 is 0.028300000000000002 in binary arithmetic; a report cell must read -0.0283.
  it('writes a percent without the floating-point tail', async () => {
    const mock = makeSheets([columnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: 0, pnl_percent: -2.83, id: 'A' }],
    });

    expect(mock.append.mock.calls[0][0].requestBody.values[0][2]).toBe(-0.0283);
  });

  it('keeps a genuinely long number intact', async () => {
    const priceColumnList = ['symbol', 'entry_price', 'id'];
    const mock = makeSheets([priceColumnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList: priceColumnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      recordList: [{ symbol: 'BTCUSDT', entry_price: 0.00619640833333333, id: 'A' }],
    });

    expect(mock.append.mock.calls[0][0].requestBody.values[0][1]).toBe(0.00619640833333333);
  });

  // A row already carrying today's values must not be rewritten: the sheet returns typed cells, the
  // mirror builds typed cells, and comparing them as text is what keeps the two sides equal.
  it('leaves an unchanged row alone when the sheet holds it as a number', async () => {
    const entryTimeMs = Date.UTC(2021, 0, 1, 13, 7);
    // The sheet holds what the mirror last wrote — the serial trimmed to 15 significant digits.
    const serial = Number.parseFloat(toSheetsSerialDate(entryTimeMs).toPrecision(15));
    const mock = makeSheets([columnList, ['BTCUSDT', String(serial), '0.1234', 'A']]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: entryTimeMs, pnl_percent: 12.34, id: 'A' }],
    });

    expect(mock.append).not.toHaveBeenCalled();
    expect(mock.batchUpdate).not.toHaveBeenCalled();
  });
});

describe('fullReplaceSheet', () => {
  it('applies the date format after rewriting the sheet', async () => {
    const columnList = ['symbol', 'entry_time', 'id'];
    const mock = makeSheets([columnList]);

    await fullReplaceSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList: ['entry_time'],
      percentColumnList: [],
      recordList: [{ symbol: 'BTCUSDT', entry_time: Date.UTC(2021, 0, 1), id: 'A' }],
    });

    expect(mock.clear).toHaveBeenCalledTimes(1);
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(firstNumberFormat(mock.formatBatchUpdate).repeatCell?.cell?.userEnteredFormat?.numberFormat?.type).toBe('DATE_TIME');
  });
});
