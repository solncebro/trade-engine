import type { Kline } from '../types/index';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface TrendCalculatorConfig {
  atrPeriod?: number;
  reversalAtrMultiplier?: number;
  minReversalPercent?: number;
  maxReversalPercent?: number;
  pivotWindowCount?: number;
  breakDepthPercent?: number;
}

export interface TrendPivot {
  type: 'high' | 'low';
  price: number;
  klineIndex: number;
  klineOpenTimestamp: number;
}

export interface TrendStrengthComponents {
  consistencyScore: number;
  steepnessScore: number;
  pullbackScore: number;
}

export interface TrendRunResult {
  startIndex: number;
  endIndex: number;
  direction: TrendDirection;
}

export interface TrendAssessment {
  direction: TrendDirection;
  strengthPercent: number;
  strengthComponents: TrendStrengthComponents;
  pivotList: TrendPivot[];
  trendStartIndex: number | null;
  trendEndIndex: number | null;
  isYoungAfterBreak: boolean;
  structureBreakPrice: number | null;
  isStructureBroken: boolean;
  lastClosePrice: number;
  lastKlineOpenTimestamp: number;
}

export type TrendAssessmentResult =
  | { kind: 'assessed'; assessment: TrendAssessment }
  | {
      kind: 'insufficient_data';
      confirmedPivotCount: number;
      requiredPivotCount: number;
    };

export interface ComputePivotListArgs {
  klineList: Kline[];
  config?: TrendCalculatorConfig;
}

export interface AssessTrendArgs {
  klineList: Kline[];
  config?: TrendCalculatorConfig;
}
