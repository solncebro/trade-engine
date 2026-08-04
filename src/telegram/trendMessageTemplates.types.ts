import type { TrendSummary } from '../core/TrendMonitor.types';

export interface FormatTrendSummaryMessageArgs {
  symbol: string;
  summary: TrendSummary;
}
