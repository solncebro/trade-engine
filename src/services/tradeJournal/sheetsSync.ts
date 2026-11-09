import { auth as googleAuth, sheets as googleSheets, sheets_v4 } from '@googleapis/sheets';

import type {
  ApplyColumnFormatsArgs,
  EnsureDateColumnFormatArgs,
  EnsureSheetHeaderArgs,
  ReplaceSheetValuesArgs,
  SheetSyncArgs,
  SortSheetDataArgs,
} from './sheetsSync.types';

import { logger } from '../../core/logger';
import { createDate } from '../../utils/date.utils';

export type { ReplaceSheetValuesArgs } from './sheetsSync.types';

const MS_PER_DAY = 86_400_000;
const SHEETS_EPOCH_OFFSET_DAYS = 25_569;
const DATE_TIME_PATTERN = 'yyyy-mm-dd hh:mm:ss';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// Doubles carry ~15-17 significant digits; the last two are where binary arithmetic leaves its litter
// (2.83 / 100 → 0.028300000000000002). Re-reading a value at 15 digits drops the litter and keeps every
// genuinely long number intact (a weighted average entry price uses 15 digits and survives untouched).
const SIGNIFICANT_DIGIT_LIMIT = 15;

interface ResolvedSheet {
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

function toResolvedSheet(properties: sheets_v4.Schema$SheetProperties | undefined): ResolvedSheet | null {
  if (!properties || properties.sheetId === null || properties.sheetId === undefined || !properties.title) {
    return null;
  }

  return { sheetId: properties.sheetId, title: properties.title };
}

// Without a name the bot writes to the FIRST sheet (tab) of the spreadsheet, whatever its name. With a
// name it writes to the sheet of that title and creates it when missing — a per-trader sheet appears
// the first time that trader has a row, nobody has to prepare it by hand.
async function resolveTargetSheet(sheets: sheets_v4.Sheets, spreadsheetId: string, sheetName?: string): Promise<ResolvedSheet | null> {
  const response = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title,index)' });
  const sheetList = response.data.sheets ?? [];

  if (sheetName === undefined) {
    return toResolvedSheet((sheetList.find((entry) => entry.properties?.index === 0) ?? sheetList[0])?.properties);
  }

  const existing = sheetList.find((entry) => entry.properties?.title === sheetName);

  if (existing !== undefined) {
    return toResolvedSheet(existing.properties);
  }

  const createResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });

  return toResolvedSheet(createResponse.data.replies?.[0]?.addSheet?.properties);
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

// Apply every schema-owned display format from the row below the header down. Date cells hold serial
// numbers and otherwise render as bare numbers; appended rows do not reliably inherit column formats.
// Re-applying the formats after each changed batch also repairs accidental formatting drift in Sheets.
async function applyColumnFormats(args: ApplyColumnFormatsArgs): Promise<void> {
  const numberFormatByColumn = new Map<string, sheets_v4.Schema$NumberFormat>();

  for (const column of args.dateColumnList) {
    numberFormatByColumn.set(column, { type: 'DATE_TIME', pattern: DATE_TIME_PATTERN });
  }

  for (const [column, pattern] of Object.entries(args.numberFormatByColumn ?? {})) {
    numberFormatByColumn.set(column, { type: pattern.includes('%') ? 'PERCENT' : 'NUMBER', pattern });
  }

  const requestList: sheets_v4.Schema$Request[] = [...numberFormatByColumn.entries()]
    .map(([column, numberFormat]) => ({ index: args.columnList.indexOf(column), numberFormat }))
    .filter(({ index }) => index >= 0)
    .map(({ index, numberFormat }) => ({
      repeatCell: {
        range: { sheetId: args.sheetId, startRowIndex: 1, startColumnIndex: index, endColumnIndex: index + 1 },
        cell: { userEnteredFormat: { numberFormat } },
        fields: 'userEnteredFormat.numberFormat',
      },
    }));

  if (requestList.length === 0) {
    return;
  }

  await args.sheets.spreadsheets.batchUpdate({ spreadsheetId: args.spreadsheetId, requestBody: { requests: requestList } });
}

async function sortSheetData(args: SortSheetDataArgs): Promise<void> {
  const orderColumnIndex = args.orderColumn === undefined ? -1 : args.columnList.indexOf(args.orderColumn);

  if (orderColumnIndex < 0) {
    return;
  }

  await args.sheets.spreadsheets.batchUpdate({
    spreadsheetId: args.spreadsheetId,
    requestBody: {
      requests: [{
        sortRange: {
          // No end column: the whole row moves, so a column kept by hand right of the journal's own
          // columns stays with its trade instead of being left behind by the sort.
          range: { sheetId: args.sheetId, startRowIndex: 1, startColumnIndex: 0 },
          sortSpecs: [{ dimensionIndex: orderColumnIndex, sortOrder: 'ASCENDING' }],
        },
      }],
    },
  });
}

// Mirror `recordList` into the target sheet (the first one unless `sheetName` is given): append rows whose key is new, update rows
// whose values changed. Idempotent — Supabase stays the source of truth, the sheet is overwritten to
// match. Shared by the live flush, the periodic reconcile, and the manual full sync.
export async function syncRecordListToSheet(args: SheetSyncArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, keyColumn, dateColumnList, percentColumnList, recordList } = args;

  if (recordList.length === 0) {
    return;
  }

  const first = await resolveTargetSheet(sheets, spreadsheetId, args.sheetName);

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
  const appendKeyList: string[] = [];
  const updateKeyList: string[] = [];

  for (const record of recordList) {
    const key = String(formatCell(record[keyColumn]));
    const values = toSheetRow(record, columnList, dateColumnSet, percentColumnSet);
    const current = existingByKey.get(key);

    if (!current) {
      appendList.push(values);
      appendKeyList.push(key);

      continue;
    }

    if (JSON.stringify(current.values) !== JSON.stringify(toComparableRow(values))) {
      updateList.push({ range: sheetRange(first.title, `A${current.rowNumber}:${lastColumn}${current.rowNumber}`), values: [values] });
      updateKeyList.push(key);
    }
  }

  logger.info({ sheetName: first.title, sheetId: first.sheetId, stage: 'sheets_rows_compared', recordCount: recordList.length, appendCount: appendList.length, updateCount: updateList.length, unchangedCount: recordList.length - appendList.length - updateList.length }, '[SheetsSync] Existing sheet rows compared with the journal');

  if (appendList.length > 0) {
    logger.info({ sheetName: first.title, stage: 'sheets_append_started', tradeIdList: appendKeyList }, '[SheetsSync] Appending missing rows');
    // Unbounded range + INSERT_ROWS: Google grows the grid for every appended row, so the sheet NEVER
    // runs out at the default 1000-row allocation. Do NOT change to a bounded range or OVERWRITE.
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: sheetRange(first.title, `A:${lastColumn}`),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appendList },
    });
    logger.info({ sheetName: first.title, stage: 'sheets_append_confirmed', tradeIdList: appendKeyList }, '[SheetsSync] Missing rows appended');

  }

  if (updateList.length > 0) {
    logger.info({ sheetName: first.title, stage: 'sheets_update_started', tradeIdList: updateKeyList }, '[SheetsSync] Updating changed rows');
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updateList },
    });
    logger.info({ sheetName: first.title, stage: 'sheets_update_confirmed', tradeIdList: updateKeyList }, '[SheetsSync] Changed rows updated');
  }

  if (appendList.length > 0 || updateList.length > 0) {
    logger.info({ sheetName: first.title, stage: 'sheets_formats_started' }, '[SheetsSync] Applying configured column formats');
    await applyColumnFormats({
      sheets,
      spreadsheetId,
      sheetId: first.sheetId,
      columnList,
      dateColumnList,
      numberFormatByColumn: args.numberFormatByColumn,
    });
    logger.info({ sheetName: first.title, stage: 'sheets_formats_confirmed' }, '[SheetsSync] Column formats applied');

    logger.info({ sheetName: first.title, stage: 'sheets_sort_started', orderColumn: args.orderColumn }, '[SheetsSync] Sorting the sheet by configured order');
    await sortSheetData({
      sheets,
      spreadsheetId,
      sheetId: first.sheetId,
      columnList,
      orderColumn: args.orderColumn,
    });
    logger.info({ sheetName: first.title, stage: 'sheets_sort_confirmed', orderColumn: args.orderColumn }, '[SheetsSync] Sheet order confirmed');
  }
}

// One-shot FULL sync: clear the whole data range (removing stale rows) then write header + every record
// in ONE update. A bulk reconcile is never rate-limit-rejected by Sheets, unlike per-row churn.
export async function fullReplaceSheet(args: SheetSyncArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, dateColumnList, percentColumnList, recordList } = args;
  const first = await resolveTargetSheet(sheets, spreadsheetId, args.sheetName);

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

  await applyColumnFormats({
    sheets,
    spreadsheetId,
    sheetId: first.sheetId,
    columnList,
    dateColumnList,
    numberFormatByColumn: args.numberFormatByColumn,
  });
}

// Connect at startup and make sure the target sheet's header row matches `columnList` — write it when the
// sheet is empty or the header drifted. Returns true when a sheet was reachable (connection confirmed).
export async function ensureSheetHeader(args: EnsureSheetHeaderArgs): Promise<boolean> {
  const { sheets, spreadsheetId, columnList } = args;
  const first = await resolveTargetSheet(sheets, spreadsheetId, args.sheetName);

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

// Startup pass for every schema-owned display format. Idempotent; write paths re-apply the same map.
export async function ensureDateColumnFormat(args: EnsureDateColumnFormatArgs): Promise<void> {
  const { sheets, spreadsheetId, columnList, dateColumnList } = args;
  const first = await resolveTargetSheet(sheets, spreadsheetId, args.sheetName);

  if (first === null) {
    return;
  }

  await applyColumnFormats({
    sheets,
    spreadsheetId,
    sheetId: first.sheetId,
    columnList,
    dateColumnList,
    numberFormatByColumn: args.numberFormatByColumn,
  });
}

// Rewrite a whole named sheet with a ready matrix — a summary sheet whose layout is not one row per
// record ("Сводка"). Clears everything first so a shorter table leaves no stale rows below it.
export async function replaceSheetValues(args: ReplaceSheetValuesArgs): Promise<boolean> {
  const { sheets, spreadsheetId, sheetName, valueMatrix } = args;
  const target = await resolveTargetSheet(sheets, spreadsheetId, sheetName);

  if (target === null) {
    return false;
  }

  // A bare quoted title is the whole sheet in A1 notation — every column, however wide the summary got.
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${target.title.replace(/'/g, "''")}'` });

  if (valueMatrix.length === 0) {
    return true;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(target.title, 'A1'),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: valueMatrix.map((row) => row.map((cell) => (typeof cell === 'number' && Number.isFinite(cell) ? toCleanNumber(cell) : cell))) },
  });

  return true;
}
