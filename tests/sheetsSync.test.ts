import { sheets_v4 } from '@googleapis/sheets';

import { ensureDateColumnFormat, ensureSheetHeader, fullReplaceSheet, replaceSheetValues, syncRecordListToSheet, toSheetsSerialDate } from '../src/services/tradeJournal/sheetsSync';

jest.mock('../src/core/logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

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

function numberFormatRequestList(formatBatchUpdate: jest.Mock): sheets_v4.Schema$Request[] {
  return formatBatchUpdate.mock.calls.flatMap((call) => call[0].requestBody.requests as sheets_v4.Schema$Request[]);
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

describe('ensureDateColumnFormat', () => {
  it('applies configured number formats together with the date format at startup', async () => {
    const columnList = ['entry_time', 'entry_price', 'size_usd', 'pnl_percent'];
    const mock = makeSheets([columnList]);

    await ensureDateColumnFormat({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      dateColumnList: ['entry_time'],
      numberFormatByColumn: {
        entry_price: '0.########',
        size_usd: '0.00',
        pnl_percent: '0.00%',
      },
    });

    expect(numberFormatRequestList(mock.formatBatchUpdate).map((request) => request.repeatCell?.cell?.userEnteredFormat?.numberFormat)).toEqual([
      { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' },
      { type: 'NUMBER', pattern: '0.########' },
      { type: 'NUMBER', pattern: '0.00' },
      { type: 'PERCENT', pattern: '0.00%' },
    ]);
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

  it('sorts the data rows by the configured order column after appending', async () => {
    const mock = makeSheets([columnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      orderColumn: 'entry_time',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: Date.UTC(2021, 0, 1), pnl_percent: 12.34, id: 'A' }],
    });

    expect(mock.formatBatchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: {
        requests: expect.arrayContaining([{
          sortRange: {
            range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 0 },
            sortSpecs: [{ dimensionIndex: 1, sortOrder: 'ASCENDING' }],
          },
        }]),
      },
    }));
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

  it('sorts the data rows after updating an existing row', async () => {
    const mock = makeSheets([columnList, ['BTCUSDT', '', '', 'A']]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      orderColumn: 'entry_time',
      dateColumnList,
      percentColumnList,
      recordList: [{ symbol: 'BTCUSDT', entry_time: 1, pnl_percent: 5, id: 'A' }],
    });

    expect(mock.formatBatchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: {
        requests: [{
          sortRange: {
            range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 0 },
            sortSpecs: [{ dimensionIndex: 1, sortOrder: 'ASCENDING' }],
          },
        }],
      },
    }));
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

  it('applies the configured money format after appending a row', async () => {
    const moneyColumnList = ['symbol', 'size_usd', 'id'];
    const mock = makeSheets([moneyColumnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList: moneyColumnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      numberFormatByColumn: { size_usd: '0.00' },
      recordList: [{ symbol: 'BTCUSDT', size_usd: 12.34567, id: 'A' }],
    });

    expect(firstNumberFormat(mock.formatBatchUpdate).repeatCell?.cell?.userEnteredFormat?.numberFormat).toEqual({
      type: 'NUMBER',
      pattern: '0.00',
    });
  });

  it('applies the configured price format after updating a row', async () => {
    const priceColumnList = ['symbol', 'entry_price', 'id'];
    const mock = makeSheets([priceColumnList, ['BTCUSDT', '1', 'A']]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList: priceColumnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      numberFormatByColumn: { entry_price: '0.########' },
      recordList: [{ symbol: 'BTCUSDT', entry_price: 1.23456789, id: 'A' }],
    });

    expect(firstNumberFormat(mock.formatBatchUpdate).repeatCell?.cell?.userEnteredFormat?.numberFormat).toEqual({
      type: 'NUMBER',
      pattern: '0.########',
    });
  });

  it('leaves the date format alone when nothing was appended', async () => {
    const mock = makeSheets([columnList, ['BTCUSDT', '', '0.05', 'A']]);

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
    expect(mock.formatBatchUpdate).not.toHaveBeenCalled();
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

  it('applies the configured percent format after rewriting the sheet', async () => {
    const columnList = ['symbol', 'pnl_percent', 'id'];
    const mock = makeSheets([columnList]);

    await fullReplaceSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: ['pnl_percent'],
      numberFormatByColumn: { pnl_percent: '0.00%' },
      recordList: [{ symbol: 'BTCUSDT', pnl_percent: 12.34, id: 'A' }],
    });

    expect(firstNumberFormat(mock.formatBatchUpdate).repeatCell?.cell?.userEnteredFormat?.numberFormat).toEqual({
      type: 'PERCENT',
      pattern: '0.00%',
    });
  });
});

// Named targets: the answer shapes of spreadsheets.get / batchUpdate(addSheet) follow the installed
// @googleapis/sheets typings (Schema$Spreadsheet.sheets[].properties, Schema$Response.addSheet.properties).
function makeNamedSheets(existingTitleList: string[], existingRowList: string[][] = []): SheetsMock & { spreadsheetGet: jest.Mock } {
  const mock = makeSheets(existingRowList);
  const spreadsheetGet = jest.fn().mockResolvedValue({
    data: { sheets: existingTitleList.map((title, index) => ({ properties: { sheetId: 100 + index, title, index } })) },
  });

  mock.formatBatchUpdate.mockImplementation(async (request: { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
    const addSheet = request.requestBody.requests?.[0]?.addSheet;

    return addSheet === undefined
      ? {}
      : { data: { replies: [{ addSheet: { properties: { sheetId: 777, title: addSheet.properties?.title, index: existingTitleList.length } } }] } };
  });
  (mock.sheets.spreadsheets as unknown as { get: jest.Mock }).get = spreadsheetGet;

  return { ...mock, spreadsheetGet };
}

describe('named sheet targets', () => {
  const columnList = ['symbol', 'trader', 'id'];

  it('writes into the sheet of that title, not the first one', async () => {
    const mock = makeNamedSheets(['Сделки', 'Иван'], [columnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      recordList: [{ symbol: 'BTCUSDT', trader: 'Иван', id: 'A' }],
      sheetName: 'Иван',
    });

    expect(mock.get.mock.calls[0][0].range).toBe("'Иван'!A:C");
    expect(mock.append.mock.calls[0][0].range).toBe("'Иван'!A:C");
    expect(mock.formatBatchUpdate.mock.calls.some((call) => call[0].requestBody.requests?.[0]?.addSheet !== undefined)).toBe(false);
  });

  it('creates a missing sheet and writes its header before the rows', async () => {
    const mock = makeNamedSheets(['Сделки'], []);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      recordList: [{ symbol: 'BTCUSDT', trader: 'Пётр', id: 'A' }],
      sheetName: 'Пётр',
    });

    expect(mock.formatBatchUpdate.mock.calls[0][0].requestBody.requests[0].addSheet.properties.title).toBe('Пётр');
    expect(mock.update.mock.calls[0][0]).toEqual(expect.objectContaining({ range: "'Пётр'!A1", requestBody: { values: [columnList] } }));
    expect(mock.append).toHaveBeenCalledTimes(1);
  });

  it('ensureSheetHeader creates the named sheet with its header', async () => {
    const mock = makeNamedSheets(['Сделки'], []);

    await expect(ensureSheetHeader({ sheets: mock.sheets, spreadsheetId: 'id', columnList, sheetName: 'Сводка' })).resolves.toBe(true);
    expect(mock.update.mock.calls[0][0].range).toBe("'Сводка'!A1");
  });

  it('keeps writing to the first sheet when no name is given', async () => {
    const mock = makeNamedSheets(['Сделки', 'Иван'], [columnList]);

    await syncRecordListToSheet({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      columnList,
      keyColumn: 'id',
      dateColumnList: [],
      percentColumnList: [],
      recordList: [{ symbol: 'BTCUSDT', trader: 'Иван', id: 'A' }],
    });

    expect(mock.append.mock.calls[0][0].range).toBe("'Сделки'!A:C");
  });
});

describe('replaceSheetValues', () => {
  it('clears the whole named sheet and writes the matrix from A1 with clean numbers', async () => {
    const mock = makeNamedSheets(['Сделки', 'Сводка']);

    await expect(replaceSheetValues({
      sheets: mock.sheets,
      spreadsheetId: 'id',
      sheetName: 'Сводка',
      valueMatrix: [['Трейдер', 'Сделок', 'Доход, %'], ['Иван', 3, 0.028300000000000002]],
    })).resolves.toBe(true);

    expect(mock.clear.mock.calls[0][0].range).toBe("'Сводка'");
    expect(mock.update.mock.calls[0][0]).toEqual(expect.objectContaining({
      range: "'Сводка'!A1",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Трейдер', 'Сделок', 'Доход, %'], ['Иван', 3, 0.0283]] },
    }));
  });

  it('creates the summary sheet when it does not exist yet', async () => {
    const mock = makeNamedSheets(['Сделки']);

    await replaceSheetValues({ sheets: mock.sheets, spreadsheetId: 'id', sheetName: 'Сводка', valueMatrix: [['x']] });

    expect(mock.formatBatchUpdate.mock.calls[0][0].requestBody.requests[0].addSheet.properties.title).toBe('Сводка');
    expect(mock.update).toHaveBeenCalledTimes(1);
  });
});
