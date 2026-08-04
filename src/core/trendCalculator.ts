import type {
  AssessTrendArgs,
  ComputePivotListArgs,
  TrendAssessmentResult,
  TrendDirection,
  TrendPivot,
  TrendRunResult,
} from './trendCalculator.types';

import type { Kline } from '../types/index';
import {
  calculateAverageFromValueList,
  calculatePercentChange,
} from '../utils/indicators';

const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_REVERSAL_ATR_MULTIPLIER = 1.618;
const DEFAULT_MIN_REVERSAL_PERCENT = 0.5;
const DEFAULT_MAX_REVERSAL_PERCENT = 20;
const DEFAULT_PIVOT_WINDOW_COUNT = 6;

const REQUIRED_PIVOT_COUNT_PER_TYPE = 2;
const CONSISTENCY_WEIGHT = 0.4;
const STEEPNESS_WEIGHT = 0.3;
const PULLBACK_WEIGHT = 0.3;
const YOUNG_AFTER_BREAK_STRENGTH_FACTOR = 0.5;
const DEFAULT_BREAK_DEPTH_PERCENT = 15;
const BREAK_LOOKBACK_PIVOTS = 6;

type PivotSearchMode = 'init' | 'up' | 'down';

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function buildTrueRangeList(klineList: Kline[]): number[] {
  const trueRangeList: number[] = [];

  for (let i = 0; i < klineList.length; i++) {
    const kline = klineList[i];

    if (i === 0) {
      trueRangeList.push(kline.highPrice - kline.lowPrice);

      continue;
    }

    const previousClose = klineList[i - 1].closePrice;
    const highToLow = kline.highPrice - kline.lowPrice;
    const highToPreviousClose = Math.abs(kline.highPrice - previousClose);
    const lowToPreviousClose = Math.abs(kline.lowPrice - previousClose);

    trueRangeList.push(
      Math.max(highToLow, highToPreviousClose, lowToPreviousClose)
    );
  }

  return trueRangeList;
}

function hasClosedBelowSince(
  klineList: Kline[],
  afterIndex: number,
  level: number
): boolean {
  for (let i = afterIndex + 1; i < klineList.length; i++) {
    if (klineList[i].closePrice < level) {
      return true;
    }
  }

  return false;
}

function hasClosedAboveSince(
  klineList: Kline[],
  afterIndex: number,
  level: number
): boolean {
  for (let i = afterIndex + 1; i < klineList.length; i++) {
    if (klineList[i].closePrice > level) {
      return true;
    }
  }

  return false;
}

function computeLastAtrPercent(klineList: Kline[], atrPeriod: number): number {
  const lastIndex = klineList.length - 1;

  if (lastIndex < 0) {
    return 0;
  }

  const lastClosePrice = klineList[lastIndex].closePrice;

  if (lastClosePrice <= 0) {
    return 0;
  }

  const trueRangeList = buildTrueRangeList(klineList);
  const averageTrueRange = calculateAverageFromValueList(
    trueRangeList,
    lastIndex,
    atrPeriod
  );

  return (averageTrueRange / lastClosePrice) * 100;
}

function computeSameTypeStepList(
  highPivotList: TrendPivot[],
  lowPivotList: TrendPivot[]
): number[] {
  const stepList: number[] = [];

  for (let i = 1; i < highPivotList.length; i++) {
    const step = Math.sign(highPivotList[i].price - highPivotList[i - 1].price);

    if (step !== 0) {
      stepList.push(step);
    }
  }

  for (let i = 1; i < lowPivotList.length; i++) {
    const step = Math.sign(lowPivotList[i].price - lowPivotList[i - 1].price);

    if (step !== 0) {
      stepList.push(step);
    }
  }

  return stepList;
}

function resolveDominantDirection(stepList: number[]): TrendDirection {
  const sum = stepList.reduce((accumulator, step) => accumulator + step, 0);

  if (sum > 0) {
    return 'up';
  }

  if (sum < 0) {
    return 'down';
  }

  return 'flat';
}

function computeConsistencyScore(
  stepList: number[],
  direction: TrendDirection
): number {
  if (stepList.length === 0) {
    return 0;
  }

  let directionSign = 0;

  if (direction === 'up') {
    directionSign = 1;
  } else if (direction === 'down') {
    directionSign = -1;
  }

  if (directionSign === 0) {
    return 50;
  }

  const matchCount = stepList.filter(step => step === directionSign).length;

  return (matchCount / stepList.length) * 100;
}

function computeSteepnessTermList(pivotList: TrendPivot[]): number[] {
  const termList: number[] = [];

  for (let i = 1; i < pivotList.length; i++) {
    const earlierPivot = pivotList[i - 1];
    const laterPivot = pivotList[i];

    if (earlierPivot.price <= 0) {
      continue;
    }

    const klineSpan = laterPivot.klineIndex - earlierPivot.klineIndex;

    if (klineSpan <= 0) {
      continue;
    }

    const movePercent =
      (Math.abs(laterPivot.price - earlierPivot.price) / earlierPivot.price) *
      100;

    termList.push(movePercent / klineSpan);
  }

  return termList;
}

function computeSteepnessScore(
  highPivotList: TrendPivot[],
  lowPivotList: TrendPivot[],
  atrPercent: number
): number {
  if (atrPercent <= 0) {
    return 0;
  }

  const termList = [
    ...computeSteepnessTermList(highPivotList),
    ...computeSteepnessTermList(lowPivotList),
  ];

  if (termList.length === 0) {
    return 0;
  }

  const averageTerm =
    termList.reduce((accumulator, term) => accumulator + term, 0) /
    termList.length;

  return clamp(averageTerm / atrPercent, 0, 1) * 100;
}

function computePullbackScore(pivotList: TrendPivot[]): number {
  if (pivotList.length < 3) {
    return 0;
  }

  const legList: number[] = [];

  for (let i = 1; i < pivotList.length; i++) {
    legList.push(Math.abs(pivotList[i].price - pivotList[i - 1].price));
  }

  const ratioList: number[] = [];

  for (let i = 1; i < legList.length; i++) {
    const maxLeg = Math.max(legList[i - 1], legList[i]);

    if (maxLeg <= 0) {
      continue;
    }

    ratioList.push(Math.min(legList[i - 1], legList[i]) / maxLeg);
  }

  if (ratioList.length === 0) {
    return 0;
  }

  const averageRatio =
    ratioList.reduce((accumulator, ratio) => accumulator + ratio, 0) /
    ratioList.length;

  return clamp(1 - averageRatio, 0, 1) * 100;
}

function isRunValid(
  pivotList: TrendPivot[],
  startIndex: number,
  endIndex: number
): boolean {
  let highCount = 0;
  let lowCount = 0;

  for (let i = startIndex; i <= endIndex; i++) {
    if (pivotList[i].type === 'high') {
      highCount++;
    } else {
      lowCount++;
    }
  }

  return (
    highCount >= REQUIRED_PIVOT_COUNT_PER_TYPE &&
    lowCount >= REQUIRED_PIVOT_COUNT_PER_TYPE
  );
}

function extendMonotonicRunStart(
  pivotList: TrendPivot[],
  endIndex: number,
  direction: TrendDirection
): number {
  const wantsLowerGoingBack = direction === 'up';
  let startIndex = endIndex;
  let laterHigh: number | null = null;
  let laterLow: number | null = null;

  for (let i = endIndex; i >= 0; i--) {
    const pivot = pivotList[i];

    if (pivot.type === 'high') {
      const breaksRun =
        laterHigh !== null &&
        (wantsLowerGoingBack
          ? pivot.price >= laterHigh
          : pivot.price <= laterHigh);

      if (breaksRun) {
        break;
      }

      laterHigh = pivot.price;
      startIndex = i;
    } else {
      const breaksRun =
        laterLow !== null &&
        (wantsLowerGoingBack
          ? pivot.price >= laterLow
          : pivot.price <= laterLow);

      if (breaksRun) {
        break;
      }

      laterLow = pivot.price;
      startIndex = i;
    }
  }

  const baseType = direction === 'up' ? 'low' : 'high';

  while (startIndex < endIndex && pivotList[startIndex].type !== baseType) {
    startIndex++;
  }

  return startIndex;
}

function findTrendRun(pivotList: TrendPivot[]): TrendRunResult | null {
  for (let endIndex = pivotList.length - 1; endIndex >= 3; endIndex--) {
    for (const direction of ['up', 'down'] as const) {
      const startIndex = extendMonotonicRunStart(
        pivotList,
        endIndex,
        direction
      );

      if (isRunValid(pivotList, startIndex, endIndex)) {
        return { startIndex, endIndex, direction };
      }
    }
  }

  return null;
}

function hasRecentReversalBreak(
  pivotList: TrendPivot[],
  direction: TrendDirection,
  minDepthPercent: number
): boolean {
  if (direction !== 'up' && direction !== 'down') {
    return false;
  }

  const type = direction === 'up' ? 'low' : 'high';
  const relevantList = pivotList
    .filter(pivot => pivot.type === type)
    .slice(-BREAK_LOOKBACK_PIVOTS);

  for (let i = 1; i < relevantList.length; i++) {
    const previousPrice = relevantList[i - 1].price;
    const currentPrice = relevantList[i].price;

    if (previousPrice <= 0) {
      continue;
    }

    if (direction === 'up' && currentPrice < previousPrice) {
      const dropPercent =
        ((previousPrice - currentPrice) / previousPrice) * 100;

      if (dropPercent >= minDepthPercent) {
        return true;
      }
    }

    if (direction === 'down' && currentPrice > previousPrice) {
      const risePercent =
        ((currentPrice - previousPrice) / previousPrice) * 100;

      if (risePercent >= minDepthPercent) {
        return true;
      }
    }
  }

  return false;
}

class TrendCalculator {
  static computePivotList(args: ComputePivotListArgs): TrendPivot[] {
    const { klineList, config } = args;

    if (klineList.length < 2) {
      return [];
    }

    const atrPeriod = config?.atrPeriod ?? DEFAULT_ATR_PERIOD;
    const reversalAtrMultiplier =
      config?.reversalAtrMultiplier ?? DEFAULT_REVERSAL_ATR_MULTIPLIER;
    const minReversalPercent =
      config?.minReversalPercent ?? DEFAULT_MIN_REVERSAL_PERCENT;
    const maxReversalPercent =
      config?.maxReversalPercent ?? DEFAULT_MAX_REVERSAL_PERCENT;

    const trueRangeList = buildTrueRangeList(klineList);
    const pivotList: TrendPivot[] = [];

    const appendPivot = (
      type: 'high' | 'low',
      price: number,
      klineIndex: number
    ): void => {
      pivotList.push({
        type,
        price,
        klineIndex,
        klineOpenTimestamp: klineList[klineIndex].openTimestamp,
      });
    };

    let mode: PivotSearchMode = 'init';
    let pendingReseed: 'low' | 'high' | null = null;
    let candidateHighPrice = klineList[0].highPrice;
    let candidateHighIndex = 0;
    let candidateLowPrice = klineList[0].lowPrice;
    let candidateLowIndex = 0;

    for (let i = 1; i < klineList.length; i++) {
      const kline = klineList[i];
      const closePrice = kline.closePrice;

      if (pendingReseed === 'low') {
        candidateLowPrice = kline.lowPrice;
        candidateLowIndex = i;
        pendingReseed = null;
      } else if (pendingReseed === 'high') {
        candidateHighPrice = kline.highPrice;
        candidateHighIndex = i;
        pendingReseed = null;
      }

      let atrPercent = 0;
      const averageTrueRange = calculateAverageFromValueList(
        trueRangeList,
        i,
        atrPeriod
      );

      if (closePrice > 0) {
        atrPercent = (averageTrueRange / closePrice) * 100;
      }

      const reversalThresholdPercent = clamp(
        reversalAtrMultiplier * atrPercent,
        minReversalPercent,
        maxReversalPercent
      );

      if (mode === 'init') {
        if (kline.highPrice > candidateHighPrice) {
          candidateHighPrice = kline.highPrice;
          candidateHighIndex = i;
        }

        if (kline.lowPrice < candidateLowPrice) {
          candidateLowPrice = kline.lowPrice;
          candidateLowIndex = i;
        }

        const dropFromHighPercent = -calculatePercentChange(
          closePrice,
          candidateHighPrice
        );
        const riseFromLowPercent = calculatePercentChange(
          closePrice,
          candidateLowPrice
        );
        const isHighReversal = dropFromHighPercent >= reversalThresholdPercent;
        const isLowReversal = riseFromLowPercent >= reversalThresholdPercent;

        if (
          isHighReversal &&
          (!isLowReversal || dropFromHighPercent >= riseFromLowPercent)
        ) {
          appendPivot('high', candidateHighPrice, candidateHighIndex);
          mode = 'down';

          if (candidateHighIndex === i) {
            pendingReseed = 'low';
          } else {
            candidateLowPrice = kline.lowPrice;
            candidateLowIndex = i;
          }
        } else if (isLowReversal) {
          appendPivot('low', candidateLowPrice, candidateLowIndex);
          mode = 'up';

          if (candidateLowIndex === i) {
            pendingReseed = 'high';
          } else {
            candidateHighPrice = kline.highPrice;
            candidateHighIndex = i;
          }
        }

        continue;
      }

      if (mode === 'up') {
        if (kline.highPrice > candidateHighPrice) {
          candidateHighPrice = kline.highPrice;
          candidateHighIndex = i;
        }

        const dropFromHighPercent = -calculatePercentChange(
          closePrice,
          candidateHighPrice
        );

        if (dropFromHighPercent >= reversalThresholdPercent) {
          appendPivot('high', candidateHighPrice, candidateHighIndex);
          mode = 'down';

          if (candidateHighIndex === i) {
            pendingReseed = 'low';
          } else {
            candidateLowPrice = kline.lowPrice;
            candidateLowIndex = i;
          }
        }

        continue;
      }

      if (kline.lowPrice < candidateLowPrice) {
        candidateLowPrice = kline.lowPrice;
        candidateLowIndex = i;
      }

      const riseFromLowPercent = calculatePercentChange(
        closePrice,
        candidateLowPrice
      );

      if (riseFromLowPercent >= reversalThresholdPercent) {
        appendPivot('low', candidateLowPrice, candidateLowIndex);
        mode = 'up';

        if (candidateLowIndex === i) {
          pendingReseed = 'high';
        } else {
          candidateHighPrice = kline.highPrice;
          candidateHighIndex = i;
        }
      }
    }

    return pivotList;
  }

  static assessTrend(args: AssessTrendArgs): TrendAssessmentResult {
    const { klineList, config } = args;
    const pivotList = TrendCalculator.computePivotList(args);
    const highPivotList = pivotList.filter(pivot => pivot.type === 'high');
    const lowPivotList = pivotList.filter(pivot => pivot.type === 'low');

    if (
      highPivotList.length < REQUIRED_PIVOT_COUNT_PER_TYPE ||
      lowPivotList.length < REQUIRED_PIVOT_COUNT_PER_TYPE
    ) {
      return {
        kind: 'insufficient_data',
        confirmedPivotCount: pivotList.length,
        requiredPivotCount: REQUIRED_PIVOT_COUNT_PER_TYPE * 2,
      };
    }

    const lastKline = klineList[klineList.length - 1];
    const lastClosePrice = lastKline.closePrice;
    const lastKlineOpenTimestamp = lastKline.openTimestamp;

    const lastHighPivot = highPivotList[highPivotList.length - 1];
    const lastLowPivot = lowPivotList[lowPivotList.length - 1];
    const lastHighPrice = lastHighPivot.price;
    const previousHighPrice = highPivotList[highPivotList.length - 2].price;
    const lastLowPrice = lastLowPivot.price;
    const previousLowPrice = lowPivotList[lowPivotList.length - 2].price;

    let baseDirection: TrendDirection = 'flat';

    if (lastHighPrice > previousHighPrice && lastLowPrice > previousLowPrice) {
      baseDirection = 'up';
    } else if (
      lastHighPrice < previousHighPrice &&
      lastLowPrice < previousLowPrice
    ) {
      baseDirection = 'down';
    }

    let isStructureBroken = false;

    if (baseDirection === 'up') {
      isStructureBroken = hasClosedBelowSince(
        klineList,
        lastLowPivot.klineIndex,
        lastLowPrice
      );
    } else if (baseDirection === 'down') {
      isStructureBroken = hasClosedAboveSince(
        klineList,
        lastHighPivot.klineIndex,
        lastHighPrice
      );
    }

    let direction: TrendDirection = baseDirection;

    if (isStructureBroken) {
      direction = 'flat';
    }

    let structureBreakPrice: number | null = null;

    if (direction === 'up') {
      structureBreakPrice = lastLowPrice;
    } else if (direction === 'down') {
      structureBreakPrice = lastHighPrice;
    }

    const pivotWindowCount =
      config?.pivotWindowCount ?? DEFAULT_PIVOT_WINDOW_COUNT;
    const atrPeriod = config?.atrPeriod ?? DEFAULT_ATR_PERIOD;

    const windowPivotList = pivotList.slice(-pivotWindowCount);
    const windowHighPivotList = windowPivotList.filter(
      pivot => pivot.type === 'high'
    );
    const windowLowPivotList = windowPivotList.filter(
      pivot => pivot.type === 'low'
    );
    const stepList = computeSameTypeStepList(
      windowHighPivotList,
      windowLowPivotList
    );

    let strengthDirection: TrendDirection = direction;

    if (direction === 'flat') {
      strengthDirection = resolveDominantDirection(stepList);
    }

    const atrPercent = computeLastAtrPercent(klineList, atrPeriod);
    const consistencyScore = computeConsistencyScore(
      stepList,
      strengthDirection
    );
    const steepnessScore = computeSteepnessScore(
      windowHighPivotList,
      windowLowPivotList,
      atrPercent
    );
    const pullbackScore = computePullbackScore(windowPivotList);
    const baseStrengthPercent = clamp(
      CONSISTENCY_WEIGHT * consistencyScore +
        STEEPNESS_WEIGHT * steepnessScore +
        PULLBACK_WEIGHT * pullbackScore,
      0,
      100
    );

    const breakDepthPercent =
      config?.breakDepthPercent ?? DEFAULT_BREAK_DEPTH_PERCENT;
    const trendRun = findTrendRun(pivotList);
    const trendStartIndex = trendRun ? trendRun.startIndex : null;
    const trendEndIndex = trendRun ? trendRun.endIndex : null;
    const isYoungAfterBreak =
      direction !== 'flat' &&
      hasRecentReversalBreak(pivotList, direction, breakDepthPercent);

    let strengthPercent = baseStrengthPercent;

    if (isYoungAfterBreak) {
      strengthPercent = baseStrengthPercent * YOUNG_AFTER_BREAK_STRENGTH_FACTOR;
    }

    return {
      kind: 'assessed',
      assessment: {
        direction,
        strengthPercent,
        strengthComponents: {
          consistencyScore,
          steepnessScore,
          pullbackScore,
        },
        pivotList,
        trendStartIndex,
        trendEndIndex,
        isYoungAfterBreak,
        structureBreakPrice,
        isStructureBroken,
        lastClosePrice,
        lastKlineOpenTimestamp,
      },
    };
  }
}

export { TrendCalculator };
