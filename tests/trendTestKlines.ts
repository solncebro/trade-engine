import type { Kline } from '../src/types/index';

export const KLINE_INTERVAL_MS = 60_000;

interface OhlcInput {
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
}

export function buildKlineList(closePriceList: number[]): Kline[] {
  return closePriceList.map((closePrice, index) => {
    const openPrice = index === 0 ? closePrice : closePriceList[index - 1];
    const openTimestamp = index * KLINE_INTERVAL_MS;

    return {
      openTimestamp,
      openPrice,
      highPrice: Math.max(openPrice, closePrice),
      lowPrice: Math.min(openPrice, closePrice),
      closePrice,
      volume: 0,
      closeTimestamp: openTimestamp + KLINE_INTERVAL_MS - 1,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      isClosed: true,
    };
  });
}

export function buildOhlcKlineList(ohlcList: OhlcInput[]): Kline[] {
  return ohlcList.map((ohlc, index) => {
    const openTimestamp = index * KLINE_INTERVAL_MS;

    return {
      openTimestamp,
      openPrice: ohlc.openPrice,
      highPrice: ohlc.highPrice,
      lowPrice: ohlc.lowPrice,
      closePrice: ohlc.closePrice,
      volume: 0,
      closeTimestamp: openTimestamp + KLINE_INTERVAL_MS - 1,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      isClosed: true,
    };
  });
}
