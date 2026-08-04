import type { MarketDataSource } from './marketDataSource.types';
import type {
  TrendAssessmentResult,
  TrendCalculatorConfig,
  TrendDirection,
} from './trendCalculator.types';

import type { KlineInterval } from '../types/index';

export interface TrendMonitorArgs {
  marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  config?: TrendCalculatorConfig;
}

export interface TrendChangedEvent {
  symbol: string;
  interval: KlineInterval;
  previousDirection: TrendDirection;
  currentDirection: TrendDirection;
  result: TrendAssessmentResult;
}

export type TrendChangedListener = (event: TrendChangedEvent) => void;

export interface TrendSummary {
  byInterval: Map<KlineInterval, TrendAssessmentResult | undefined>;
  alignedDirection: TrendDirection | null;
}
