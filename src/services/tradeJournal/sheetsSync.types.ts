import type { sheets_v4 } from '@googleapis/sheets';

export interface SortSheetDataArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  sheetId: number;
  columnList: readonly string[];
  orderColumn?: string;
}

export interface SheetSyncArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
  keyColumn: string;
  orderColumn?: string;
  dateColumnList: readonly string[];
  percentColumnList: readonly string[];
  numberFormatByColumn?: Readonly<Record<string, string>>;
  recordList: Record<string, unknown>[];
  sheetName?: string;
}

export interface EnsureDateColumnFormatArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
  dateColumnList: readonly string[];
  numberFormatByColumn?: Readonly<Record<string, string>>;
  sheetName?: string;
}

export interface EnsureSheetHeaderArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  columnList: readonly string[];
  sheetName?: string;
}

export interface ReplaceSheetValuesArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  sheetName: string;
  valueMatrix: (string | number)[][];
}

export interface ApplyColumnFormatsArgs {
  sheets: sheets_v4.Sheets;
  spreadsheetId: string;
  sheetId: number;
  columnList: readonly string[];
  dateColumnList: readonly string[];
  numberFormatByColumn?: Readonly<Record<string, string>>;
}
