import type { CalculatePriceRangePercentArgs, ValidateEntryPriceVsLastArgs } from './indicators.types';

import type { Kline, MaLevel, MaValues } from '../types/index';

function calculateAverageFromValueList(valueList: number[], endIndex: number, period: number): number {
  if (period <= 0 || endIndex < period - 1 || endIndex >= valueList.length) {
    return 0;
  }

  let sum = 0;

  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += valueList[i];
  }

  return sum / period;
}

function calculatePercentChange(value: number, baseValue: number): number {
  if (baseValue === 0) {
    return 0;
  }

  return (value - baseValue) / baseValue * 100;
}

function calculateSma(klineList: Kline[], period: number): number {
  if (klineList.length < period) {
    return 0;
  }

  const periodKlineList = klineList.slice(-period);
  let sum = 0;

  for (const kline of periodKlineList) {
    sum += kline.closePrice;
  }

  return sum / period;
}

function calculateSmaAt(klineList: Kline[], period: number, endIndex: number): number {
  if (endIndex < period - 1 || endIndex >= klineList.length) {
    return 0;
  }

  let sum = 0;

  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += klineList[i].closePrice;
  }

  return sum / period;
}

function calculateAllMaValues(klineList: Kline[]): MaValues {
  return {
    ma25: calculateSma(klineList, 25),
    ma50: calculateSma(klineList, 50),
    ma100: calculateSma(klineList, 100),
    ma200: calculateSma(klineList, 200),
  };
}

function getMaValue(maValues: MaValues, maLevel: MaLevel): number {
  const key = `ma${maLevel}` as keyof MaValues;
  return maValues[key];
}

function calculatePriceRangePercent(args: CalculatePriceRangePercentArgs): number {
  const { highestHigh, lowestLow, highestHighTimestamp, lowestLowTimestamp } = args;
  const isDropping = highestHighTimestamp < lowestLowTimestamp;
  const baseValue = isDropping ? highestHigh : lowestLow;

  if (baseValue === 0) {
    return 0;
  }

  return (highestHigh - lowestLow) / baseValue * 100;
}

function calculateOrderPrice(maValue: number, avgPriceOffsetPercent: number): number {
  return maValue * (1 + avgPriceOffsetPercent / 100);
}

function computeMidpointPrice(firstValue: number, secondValue: number): number {
  return (firstValue + secondValue) / 2;
}

function validateEntryPriceVsLast(args: ValidateEntryPriceVsLastArgs): boolean {
  const { price, lastPrice, direction } = args;

  if (direction === 'long') {
    return price < lastPrice;
  }

  return price > lastPrice;
}

function calculateBreakevenPrice(entryPrice: number, direction: 'long' | 'short', breakevenHalfClosePercent: number): number {
  return direction === 'long'
    ? entryPrice * (1 + breakevenHalfClosePercent / 100)
    : entryPrice * (1 - breakevenHalfClosePercent / 100);
}

function calculateValueMaSeries(valueList: number[], period: number): (number | null)[] {
  const seriesList: (number | null)[] = [];

  for (let i = 0; i < valueList.length; i++) {
    if (i < period - 1) {
      seriesList.push(null);
      continue;
    }

    let sum = 0;

    for (let j = i - period + 1; j <= i; j++) {
      sum += valueList[j];
    }

    seriesList.push(sum / period);
  }

  return seriesList;
}

function calculateMaSeries(klineList: Kline[], period: number): (number | null)[] {
  return calculateValueMaSeries(klineList.map((kline) => kline.closePrice), period);
}

export { calculateAllMaValues, calculateAverageFromValueList, calculateBreakevenPrice, calculateMaSeries, calculateOrderPrice, calculatePercentChange, calculatePriceRangePercent, calculateSma, calculateSmaAt, calculateValueMaSeries, computeMidpointPrice, getMaValue, validateEntryPriceVsLast };
