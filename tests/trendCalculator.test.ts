import {
  buildKlineList,
  buildOhlcKlineList,
  KLINE_INTERVAL_MS,
} from './trendTestKlines';

import { TrendCalculator } from '../src/core/trendCalculator';
import type {
  TrendAssessment,
  TrendCalculatorConfig,
  TrendPivot,
} from '../src/core/trendCalculator.types';
import type { Kline } from '../src/types/index';

function getPriceList(pivotList: TrendPivot[], type: 'high' | 'low'): number[] {
  return pivotList
    .filter(pivot => pivot.type === type)
    .map(pivot => pivot.price);
}

function hasStrictAlternation(pivotList: TrendPivot[]): boolean {
  for (let i = 1; i < pivotList.length; i++) {
    if (pivotList[i].type === pivotList[i - 1].type) {
      return false;
    }
  }

  return true;
}

const FLAT_THRESHOLD_CONFIG: TrendCalculatorConfig = {
  reversalAtrMultiplier: 0,
  minReversalPercent: 2,
};

describe('TrendCalculator.computePivotList', () => {
  test('returns an empty list for an empty kline list', () => {
    expect(TrendCalculator.computePivotList({ klineList: [] })).toEqual([]);
  });

  test('returns an empty list for a single kline', () => {
    const klineList = buildKlineList([100]);

    expect(TrendCalculator.computePivotList({ klineList })).toEqual([]);
  });

  test('detects an alternating rising structure with higher highs and higher lows', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 107]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });
    const highPriceList = getPriceList(pivotList, 'high');
    const lowPriceList = getPriceList(pivotList, 'low');

    expect(pivotList.length).toBeGreaterThanOrEqual(4);
    expect(hasStrictAlternation(pivotList)).toBe(true);

    for (let i = 1; i < highPriceList.length; i++) {
      expect(highPriceList[i]).toBeGreaterThan(highPriceList[i - 1]);
    }

    for (let i = 1; i < lowPriceList.length; i++) {
      expect(lowPriceList[i]).toBeGreaterThanOrEqual(lowPriceList[i - 1]);
    }
  });

  test('detects an alternating falling structure with lower highs and lower lows', () => {
    const klineList = buildKlineList([100, 96, 99, 94, 98, 93, 97, 92]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });
    const highPriceList = getPriceList(pivotList, 'high');
    const lowPriceList = getPriceList(pivotList, 'low');

    expect(pivotList.length).toBeGreaterThanOrEqual(4);
    expect(hasStrictAlternation(pivotList)).toBe(true);

    for (let i = 1; i < highPriceList.length; i++) {
      expect(highPriceList[i]).toBeLessThan(highPriceList[i - 1]);
    }

    for (let i = 1; i < lowPriceList.length; i++) {
      expect(lowPriceList[i]).toBeLessThanOrEqual(lowPriceList[i - 1]);
    }
  });

  test('produces no pivots when oscillations stay below the minimum reversal threshold', () => {
    const klineList = buildKlineList([100, 100.5, 100, 100.5, 100, 100.5, 100]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });

    expect(pivotList).toEqual([]);
  });

  test('raises the reversal threshold as volatility grows, yielding fewer pivots', () => {
    const closePriceList = [100, 104, 100, 105, 101, 106, 102, 107];
    const klineList = buildKlineList(closePriceList);

    const calmPivotList = TrendCalculator.computePivotList({
      klineList,
      config: {
        atrPeriod: 2,
        reversalAtrMultiplier: 0,
        minReversalPercent: 0.5,
      },
    });
    const volatilePivotList = TrendCalculator.computePivotList({
      klineList,
      config: {
        atrPeriod: 2,
        reversalAtrMultiplier: 5,
        minReversalPercent: 0.5,
      },
    });

    expect(calmPivotList.length).toBeGreaterThan(volatilePivotList.length);
  });

  test('anchors each pivot to its kline extreme price, index and open timestamp', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 107]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });

    expect(pivotList.length).toBeGreaterThan(0);

    for (const pivot of pivotList) {
      const kline = klineList[pivot.klineIndex];
      const extremePrice =
        pivot.type === 'high' ? kline.highPrice : kline.lowPrice;

      expect(kline).toBeDefined();
      expect(pivot.price).toBe(extremePrice);
      expect(pivot.klineOpenTimestamp).toBe(kline.openTimestamp);
    }
  });

  test('takes the pivot price from the candle wick extreme, not from the close', () => {
    const klineList = buildOhlcKlineList([
      { openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 110, lowPrice: 100, closePrice: 101 },
      { openPrice: 101, highPrice: 101, lowPrice: 90, closePrice: 100 },
    ]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });

    expect(pivotList).toEqual([
      {
        type: 'high',
        price: 110,
        klineIndex: 1,
        klineOpenTimestamp: KLINE_INTERVAL_MS,
      },
      {
        type: 'low',
        price: 90,
        klineIndex: 2,
        klineOpenTimestamp: 2 * KLINE_INTERVAL_MS,
      },
    ]);
  });

  test('never places two consecutive pivots on the same candle', () => {
    const klineList = buildOhlcKlineList([
      { openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 103, lowPrice: 100, closePrice: 103 },
      { openPrice: 103, highPrice: 130, lowPrice: 100, closePrice: 101 },
      { openPrice: 101, highPrice: 115, lowPrice: 101, closePrice: 114 },
      { openPrice: 114, highPrice: 114, lowPrice: 108, closePrice: 110 },
    ]);

    const pivotList = TrendCalculator.computePivotList({
      klineList,
      config: { reversalAtrMultiplier: 0, minReversalPercent: 3 },
    });

    expect(pivotList.length).toBeGreaterThanOrEqual(3);

    for (let i = 1; i < pivotList.length; i++) {
      expect(pivotList[i].klineIndex).toBeGreaterThan(
        pivotList[i - 1].klineIndex
      );
    }
  });

  test('caps the reversal threshold so a single volatile spike does not swallow a real pullback', () => {
    const klineList = buildOhlcKlineList([
      { openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 106, lowPrice: 100, closePrice: 106 },
      { openPrice: 106, highPrice: 106, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 260, lowPrice: 100, closePrice: 255 },
      { openPrice: 255, highPrice: 260, lowPrice: 205, closePrice: 210 },
      { openPrice: 210, highPrice: 215, lowPrice: 205, closePrice: 212 },
    ]);

    const capped = TrendCalculator.computePivotList({
      klineList,
      config: {
        atrPeriod: 3,
        reversalAtrMultiplier: 3,
        minReversalPercent: 0.5,
        maxReversalPercent: 12,
      },
    });
    const uncapped = TrendCalculator.computePivotList({
      klineList,
      config: {
        atrPeriod: 3,
        reversalAtrMultiplier: 3,
        minReversalPercent: 0.5,
        maxReversalPercent: 100,
      },
    });

    expect(capped.length).toBeGreaterThan(uncapped.length);
    expect(capped.some(p => p.type === 'high' && p.price === 260)).toBe(true);
  });
});

function assessOrThrow(
  klineList: Kline[],
  config?: TrendCalculatorConfig
): TrendAssessment {
  const result = TrendCalculator.assessTrend({ klineList, config });

  if (result.kind !== 'assessed') {
    throw new Error(`expected an assessed result, received ${result.kind}`);
  }

  return result.assessment;
}

describe('TrendCalculator.assessTrend', () => {
  test('assesses a rising structure as up with the last swing low as its break level', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 104]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('up');
    expect(assessment.isStructureBroken).toBe(false);
    expect(assessment.structureBreakPrice).toBe(101);
    expect(assessment.strengthPercent).toBeGreaterThan(0);
  });

  test('assesses a falling structure as down with the last swing high as its break level', () => {
    const klineList = buildKlineList([100, 96, 99, 94, 98, 93, 97, 92]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('down');
    expect(assessment.isStructureBroken).toBe(false);
    expect(assessment.structureBreakPrice).toBe(97);
  });

  test('flags a structure break when the last close drops below the last swing low', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 99]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('flat');
    expect(assessment.isStructureBroken).toBe(true);
    expect(assessment.structureBreakPrice).toBeNull();
  });

  test('assesses a horizontal range as flat without a structure break', () => {
    const klineList = buildKlineList([100, 104, 100, 104, 100, 104, 100, 104]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('flat');
    expect(assessment.isStructureBroken).toBe(false);
    expect(assessment.structureBreakPrice).toBeNull();
  });

  test('reports insufficient_data when fewer than two highs and two lows are confirmed', () => {
    const klineList = buildKlineList([100, 100.5, 100, 100.5]);

    const result = TrendCalculator.assessTrend({
      klineList,
      config: FLAT_THRESHOLD_CONFIG,
    });

    expect(result.kind).toBe('insufficient_data');

    if (result.kind === 'insufficient_data') {
      expect(result.confirmedPivotCount).toBe(0);
      expect(result.requiredPivotCount).toBe(4);
    }
  });

  test('scores consistency at 100 for a clean rising staircase', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 104]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.strengthComponents.consistencyScore).toBe(100);
  });

  test('keeps every strength component and the aggregate within 0..100', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 107]);

    const assessment = assessOrThrow(klineList, {
      atrPeriod: 2,
      reversalAtrMultiplier: 0,
      minReversalPercent: 2,
    });
    const { consistencyScore, steepnessScore, pullbackScore } =
      assessment.strengthComponents;

    for (const score of [
      consistencyScore,
      steepnessScore,
      pullbackScore,
      assessment.strengthPercent,
    ]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  test('rewards shallow pullbacks with a higher pullback score than deep pullbacks', () => {
    const shallowConfig: TrendCalculatorConfig = {
      reversalAtrMultiplier: 0,
      minReversalPercent: 1,
    };
    const shallowKlineList = buildKlineList([
      100, 105, 103.5, 108.5, 107, 112, 110.5, 115.5,
    ]);
    const deepKlineList = buildKlineList([
      100, 103, 100.5, 103.5, 101, 104, 101.5, 104.5,
    ]);

    const shallowAssessment = assessOrThrow(shallowKlineList, shallowConfig);
    const deepAssessment = assessOrThrow(deepKlineList, shallowConfig);

    expect(shallowAssessment.strengthComponents.pullbackScore).toBeGreaterThan(
      deepAssessment.strengthComponents.pullbackScore
    );
  });

  test('switches direction to up after a downtrend reverses into a higher-high structure', () => {
    const klineList = buildKlineList([
      120, 114, 118, 110, 116, 108, 114, 121, 116, 124, 119, 127,
    ]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('up');
  });

  test('keeps an uptrend intact when the last candle only wicks below the swing low but closes above it', () => {
    const klineList = buildOhlcKlineList([
      { openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 104, lowPrice: 100, closePrice: 104 },
      { openPrice: 104, highPrice: 104, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 105, lowPrice: 100, closePrice: 105 },
      { openPrice: 105, highPrice: 105, lowPrice: 101, closePrice: 101 },
      { openPrice: 101, highPrice: 106, lowPrice: 101, closePrice: 106 },
      { openPrice: 106, highPrice: 106, lowPrice: 99, closePrice: 104 },
    ]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('up');
    expect(assessment.isStructureBroken).toBe(false);
    expect(assessment.structureBreakPrice).toBe(101);
  });

  test('flags a downside structure break when the last close rises above the last swing high', () => {
    const klineList = buildKlineList([100, 96, 100, 95, 99, 94, 98, 101]);

    const assessment = assessOrThrow(klineList, FLAT_THRESHOLD_CONFIG);

    expect(assessment.direction).toBe('flat');
    expect(assessment.isStructureBroken).toBe(true);
    expect(assessment.structureBreakPrice).toBeNull();
  });

  test('normalises steepness against volatility and yields zero when the ATR window is not filled', () => {
    const klineList = buildKlineList([100, 104, 100, 105, 101, 106, 102, 104]);

    const shortWindowAssessment = assessOrThrow(klineList, {
      atrPeriod: 2,
      reversalAtrMultiplier: 0,
      minReversalPercent: 2,
    });
    const unfilledWindowAssessment = assessOrThrow(klineList, {
      atrPeriod: 100,
      reversalAtrMultiplier: 0,
      minReversalPercent: 2,
    });

    expect(
      shortWindowAssessment.strengthComponents.steepnessScore
    ).toBeGreaterThan(0);
    expect(unfilledWindowAssessment.strengthComponents.steepnessScore).toBe(0);
  });

  test('flags a structure break when price closed below the swing low earlier and only later recovered above it', () => {
    const klineList = buildOhlcKlineList([
      { openPrice: 100, highPrice: 100, lowPrice: 100, closePrice: 100 },
      { openPrice: 100, highPrice: 150, lowPrice: 100, closePrice: 150 },
      { openPrice: 150, highPrice: 150, lowPrice: 112, closePrice: 112 },
      { openPrice: 112, highPrice: 190, lowPrice: 112, closePrice: 190 },
      { openPrice: 190, highPrice: 190, lowPrice: 130, closePrice: 130 },
      { openPrice: 130, highPrice: 240, lowPrice: 130, closePrice: 240 },
      { openPrice: 240, highPrice: 240, lowPrice: 120, closePrice: 125 },
      { openPrice: 125, highPrice: 148, lowPrice: 120, closePrice: 148 },
    ]);

    const assessment = assessOrThrow(klineList, {
      reversalAtrMultiplier: 0,
      minReversalPercent: 25,
      maxReversalPercent: 100,
    });

    expect(assessment.lastClosePrice).toBeGreaterThan(130);
    expect(assessment.direction).toBe('flat');
    expect(assessment.isStructureBroken).toBe(true);
  });

  test('keeps a clean uptrend unflagged and anchors its start at the first rising low', () => {
    const klineList = buildKlineList([100, 110, 102, 113, 105, 117, 108, 121]);

    const assessment = assessOrThrow(klineList, {
      reversalAtrMultiplier: 0,
      minReversalPercent: 3,
    });

    expect(assessment.direction).toBe('up');
    expect(assessment.isYoungAfterBreak).toBe(false);
    expect(assessment.trendStartIndex).toBe(0);
  });

  test('flags a young-after-break uptrend, halves its strength and starts it at the break low', () => {
    const config = {
      reversalAtrMultiplier: 0,
      minReversalPercent: 3,
      breakDepthPercent: 5,
    };
    const cleanList = buildKlineList([100, 110, 102, 113, 105, 117, 108, 121]);
    const brokenList = buildKlineList([
      100, 110, 90, 105, 95, 112, 100, 116, 106, 120,
    ]);

    const clean = assessOrThrow(cleanList, config);
    const broken = assessOrThrow(brokenList, config);

    expect(broken.direction).toBe('up');
    expect(broken.isYoungAfterBreak).toBe(true);
    expect(broken.strengthPercent).toBeLessThan(clean.strengthPercent);

    const startPivot = broken.pivotList[broken.trendStartIndex ?? -1];
    expect(startPivot.type).toBe('low');
    expect(startPivot.price).toBe(90);
  });

  test('treats a pullback shallower than the break-depth threshold as a normal pullback, not a break', () => {
    const brokenList = buildKlineList([
      100, 110, 90, 105, 95, 112, 100, 116, 106, 120,
    ]);

    const assessment = assessOrThrow(brokenList, {
      reversalAtrMultiplier: 0,
      minReversalPercent: 3,
    });

    expect(assessment.direction).toBe('up');
    expect(assessment.isYoungAfterBreak).toBe(false);
  });
});
