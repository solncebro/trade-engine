import type { Kline } from '../types/index';

// Drop the trailing still-forming candle (isClosed === false) so the rightmost candle is the last
// CLOSED one. Used by closed-candle consumers: the chart layer (trigger alerts / montage) and the
// manual fib path (range/trigger must never include the live forming candle). Lightweight (no echarts)
// so infrastructure modules can import it without pulling the chart stack.
function selectClosedKlineList(klineList: Kline[]): Kline[] {
  const lastKline = klineList[klineList.length - 1];

  if (klineList.length > 1 && lastKline !== undefined && lastKline.isClosed === false) {
    return klineList.slice(0, -1);
  }

  return klineList;
}

export { selectClosedKlineList };
