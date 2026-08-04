import { auth as googleAuth, sheets as googleSheets, sheets_v4 } from '@googleapis/sheets';

import { createDate } from '../../utils/date.utils';

const MS_PER_DAY = 86_400_000;
const SHEETS_EPOCH_OFFSET_DAYS = 25_569;
const DATE_TIME_PATTERN = 'yyyy-mm-dd hh:mm:ss';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// Doubles carry ~15-17 significant digits; the last two are where binary arithmetic leaves its litter
// (2.83 / 100 → 0.028300000000000002). Re-reading a value at 15 digits drops the litter and keeps every
// genuinely long number intact (a weighted average entry price uses 15 digits and survives untouched).
const SIGNIFICANT_DIGIT_LIMIT = 15;

export interface SheetSyncArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
  keyColumn: string;
  dateColumnList: readonly string[];
  percentColumnList: readonly string[];
  recordList: Record<string, unknown>[];
}

export interface EnsureDateColumnFormatArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
  dateColumnList: readonly string[];
}

export interface EnsureSheetHeaderArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
}

interface FirstSheet {
  sheetId: number;
  title: string;
}

interface CellFormatOptions {
  isDate?: boolean;
  isPercent?: boolean;
}

// Google Sheets client authenticated from a service-account credentials file. Auth is baked into the
// client so the generic sync helpers never have to thread an auth token through every request.
export function createSheetsClient(credentialsPath: string): sheets_v4.Sheets {
  const authClient = new googleAuth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: [SHEETS_SCOPE],
  });

  return googleSheets({ version: 'v4', auth: authClient });
}

// UTC milliseconds → Google Sheets serial date (days since 1899-12-30, UTC).
export function toSheetsSerialDate(timestampMs: number): number {
  return timestampMs / MS_PER_DAY + SHEETS_EPOCH_OFFSET_DAYS;
}

// 1-based column count → spreadsheet letter of the last column (1 → 'A', 26 → 'Z', 27 → 'AA', 44 → 'AR').
// The row read/write ranges are derived from the schema's column count — NEVER hardcode 'A:Z', a table
// wider than 26 columns would silently truncate.
function columnLetter(index: number): string {
  let result = '';
  let remaining = index;

  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    result = String.fromCharCode(65 + modulo) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return result;
}

// The bot always writes to the FIRST sheet (tab) of the spreadsheet, whatever its name.
async function resolveFirstSheet(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<FirstSheet | null> {
  const response = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title,index)' });
  const sheetList = response.data.sheets ?? [];
  const properties = (sheetList.find((entry) => entry.properties?.index === 0) ?? sheetList[0])?.properties;

  if (!properties || properties.sheetId === null || properties.sheetId === undefined || !properties.title) {
    return null;
  }

  return { sheetId: properties.sheetId, title: properties.title };
}

// A1 range scoped to a sheet title, with the title quoted/escaped (spaces, quotes).
function sheetRange(title: string, cells: string): string {
  return `'${title.replace(/'/g, "''")}'!${cells}`;
}

// Drop floating-point litter and keep the value round-trip stable. The sheet is a human-facing report:
// a cell reading -0.028300000000000002 instead of -0.0283 is noise, not precision. 15 digits also
// survive the write → read comparison unchanged, so a row is never rewritten just for its own tail.
function toCleanNumber(value: number): number {
  return Number.parseFloat(value.toPrecision(SIGNIFICANT_DIGIT_LIMIT));
}

// A cell value is written TYPED: numbers as numbers, everything else as text. Never hand Sheets a
// number formatted into a string — with valueInputOption USER_ENTERED it parses the text in the
// SPREADSHEET's locale, and in a comma-decimal locale (ru_RU) "46233.04" is not a number at all, so the
// cell silently becomes text: dates stop rendering as dates and the raw digits show through.
function formatCell(value: unknown, options: CellFormatOptions = {}): string | number {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (options.isDate) {
    // A date column may hold a UTC millisecond timestamp (e.g. entry_time) OR an ISO string (e.g.
    // created_at) — accept both so any project's schema renders as a native Sheets date.
    const numericValue = Number(value);
    const timestampMs = Number.isFinite(numericValue) ? numericValue : createDate(String(value)).getTime();

    return timestampMs > 0 ? toCleanNumber(toSheetsSerialDate(timestampMs)) : '';
  }

  if (options.isPercent) {
    const percent = Number(value);

    return Number.isFinite(percent) ? toCleanNumber(percent / 100) : '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return toCleanNumber(value);
  }

  return String(value);
}

function toSheetRow(record: Record<string, unknown>, columnList: readonly string[], dateColumnSet: Set<string>, percentColumnSet: Set<string>): (string | number)[] {
  return columnList.map((column) => formatCell(record[column], { isDate: dateColumnSet.has(column), isPercent: percentColumnSet.has(column) }));
}

// Sheet cells come back typed too, so both sides are compared as text — a number and its own string
// form must not read as a change, or every row would be rewritten on every tick.
function toComparableRow(row: (string | number)[]): string[] {
  return row.map((cell) => String(cell));
}

function padRow(row: string[], length: number): string[] {
  const padded = [...row];

  while (padded.length < length) {
    padded.push('');
  }

  return padded.slice(0, length);
}

function isHeaderCurrent(currentHeader: string[], columnList: readonly string[]): boolean {
  return JSON.stringify(currentHeader) === JSON.stringify(columnList.map((column) => column));
}

async function writeSheetHeader(sheets: sheets_v4.Sheets, spreadsheetId: string, title: string, columnList: readonly string[]): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(title, 'A1'),
    valueInputOption: 'RAW',
    requestBody: { values: [columnList.map((column) => column)] },
  });
}

async function readSheetRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  columnList: readonly string[],
  keyIndex: number,
): Promise<Map<string, { rowNumber: number; values: string[] }>> {
  const result = new Map<string, { rowNumber: number; values: string[] }>();
  const lastColumn = columnLetter(columnList.length);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(title, `A:${lastColumn}`),
    // Read RAW values (serial dates / percents as numbers), not display-formatted strings. Otherwise a
    // date column reads back as a formatted date and never equals the serial string we write, so every
    // row with a date would be rewritten on every reconcile tick forever.
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rowList = response.data.values ?? [];
  const currentHeader = (rowList[0] ?? []).map((cell) => String(cell ?? ''));

  if (!isHeaderCurrent(currentHeader, columnList)) {
    await writeSheetHeader(sheets, spreadsheetId, title, columnList);
  }

  if (rowList.length === 0) {
    return result;
  }

  for (let i = 1; i < rowList.length; i++) {
    const row = padRow(rowList[i].map((cell) => String(cell ?? '')), columnList.length);
    const key = row[keyIndex];

    if (key) {
      result.set(key, { rowNumber: i + 1, values: row });
    }
  }

  return result;
}

// Give the date columns a UTC date-time number format, from the row below the header down. A date cell
// holds a serial number (whole part = days since 1899-12-30, fraction = time of day), so WITHOUT this
// format Sheets shows the bare number instead of a date. Must be re-applied after every write that
// added rows: rows arriving through append/INSERT_ROWS do not carry the format of the column they land
// in, so a one-shot pass at startup only ever dresses the rows that existed back then.
async function applyDateColumnFormat(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetId: number, columnList: readonly string[], dateColumnList: readonly string[]): Promise<void> {
  const requestList: sheets_v4.Schema$Request[] = dateColumnList
    .map((column) => columnList.indexOf(column))
    .filter((index) => index >= 0)
    .map((index) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: DATE_TIME_PATTERN } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    }));

  if (requestList.length === 0) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requestList } });
}

// Mirror `recordList` into the spreadsheet's first sheet: append rows whose key is new, update rows
// whose values changed. Idempotent — Supabase stays the source of truth, the sheet is overwritten to
// match. Shared by the live flush, the periodic reconcile, and the manual full sync.
export async function syncRecordListToSheet(args: SheetSyncArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, keyColumn, dateColumnList, percentColumnList, recordList } = args;

  if (recordList.length === 0) {
    return;
  }

  const first = await resolveFirstSheet(sheets, spreadsheetId);

  if (first === null) {
    return;
  }

  const dateColumnSet = new Set<string>(dateColumnList);
  const percentColumnSet = new Set<string>(percentColumnList);
  const keyIndex = Math.max(0, columnList.indexOf(keyColumn));
  const existingByKey = await readSheetRows(sheets, spreadsheetId, first.title, columnList, keyIndex);
  const lastColumn = columnLetter(columnList.length);
  const appendList: (string | number)[][] = [];
  const updateList: sheets_v4.Schema$ValueRange[] = [];

  for (const record of recordList) {
    const key = String(formatCell(record[keyColumn]));
    const values = toSheetRow(record, columnList, dateColumnSet, percentColumnSet);
    const current = existingByKey.get(key);

    if (!current) {
      appendList.push(values);

      continue;
    }

    if (JSON.stringify(current.values) !== JSON.stringify(toComparableRow(values))) {
      updateList.push({ range: sheetRange(first.title, `A${current.rowNumber}:${lastColumn}${current.rowNumber}`), values: [values] });
    }
  }

  if (appendList.length > 0) {
    // Unbounded range + INSERT_ROWS: Google grows the grid for every appended row, so the sheet NEVER
    // runs out at the default 1000-row allocation. Do NOT change to a bounded range or OVERWRITE.
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: sheetRange(first.title, `A:${lastColumn}`),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendList },
    });

    await applyDateColumnFormat(sheets, spreadsheetId, first.sheetId, columnList, dateColumnList);
  }

  if (updateList.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updateList },
    });
  }
}

// One-shot FULL sync: clear the whole data range (removing stale rows) then write header + every record
// in ONE update. A bulk reconcile is never rate-limit-rejected by Sheets, unlike per-row churn.
export async function fullReplaceSheet(args: SheetSyncArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, dateColumnList, percentColumnList, recordList } = args;
  const first = await resolveFirstSheet(sheets, spreadsheetId);

  if (first === null) {
    return;
  }

  const dateColumnSet = new Set<string>(dateColumnList);
  const percentColumnSet = new Set<string>(percentColumnList);
  const lastColumn = columnLetter(columnList.length);
  const valueMatrix: (string | number)[][] = [columnList.map((column) => column), ...recordList.map((record) => toSheetRow(record, columnList, dateColumnSet, percentColumnSet))];

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: sheetRange(first.title, `A:${lastColumn}`),
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(first.title, 'A1'),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: valueMatrix },
  });

  await applyDateColumnFormat(sheets, spreadsheetId, first.sheetId, columnList, dateColumnList);
}

// Connect at startup and make sure the first sheet's header row matches `columnList` — write it when the
// sheet is empty or the header drifted. Returns true when a sheet was reachable (connection confirmed).
export async function ensureSheetHeader(args: EnsureSheetHeaderArgs): Promise<boolean> {
  const { sheets, spreadsheetId, columnList } = args;
  const first = await resolveFirstSheet(sheets, spreadsheetId);

  if (first === null) {
    return false;
  }

  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetRange(first.title, '1:1') });
  const currentHeader = (response.data.values?.[0] ?? []).map((cell) => String(cell ?? ''));

  if (!isHeaderCurrent(currentHeader, columnList)) {
    await writeSheetHeader(sheets, spreadsheetId, first.title, columnList);
  }

  return true;
}

// Startup pass: dress the date columns of the first sheet so their serial values render as native
// dates. Idempotent — safe to call repeatedly. The write paths re-apply it after adding rows.
export async function ensureDateColumnFormat(args: EnsureDateColumnFormatArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, dateColumnList } = args;
  const first = await resolveFirstSheet(sheets, spreadsheetId);

  if (first === null) {
    return;
  }

  await applyDateColumnFormat(sheets, spreadsheetId, first.sheetId, columnList, dateColumnList);
}
