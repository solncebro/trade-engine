import type { HasPriceCrossedOrderPriceArgs } from './priceIntersection.types';

function hasPriceCrossedOrderPrice(args: HasPriceCrossedOrderPriceArgs): boolean {
  for (const kline of args.klineList) {
    // Skip only klines FULLY CLOSED before the reference moment. The boundary
    // kline (opened before, still open at fromOpenTimestamp) must be checked:
    // fromOpenTimestamp is a wall-clock mark (pausedAt / lastTrailedAt), so an
    // intersection inside that kline may have happened after the mark. Filtering
    // by openTimestamp alone silently dropped the boundary kline and created a
    // blind window of up to one full interval.
    if (kline.closeTimestamp <= args.fromOpenTimestamp) {
      continue;
    }

    if (args.direction === 'long') {
      if (kline.lowPrice <= args.orderPrice) {
        return true;
      }
    } else {
      if (kline.highPrice >= args.orderPrice) {
        return true;
      }
    }
  }

  return false;
}

export { hasPriceCrossedOrderPrice };
