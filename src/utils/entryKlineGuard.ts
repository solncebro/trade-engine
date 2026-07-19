import type {
  EntryKlineGuardSnapshot,
  GuardKline,
  ResolveDecisionPriceArgs,
  ResolveGuardedExtremePriceArgs,
} from './entryKlineGuard.types';

function resolveGuardedExtremePrice(args: ResolveGuardedExtremePriceArgs): number | null {
  const { kline, breakDirection, snapshot } = args;

  if (snapshot === null) {
    return null;
  }

  if (breakDirection === 'above') {
    return Number.isFinite(kline.highPrice) && kline.highPrice > snapshot ? kline.highPrice : null;
  }

  return Number.isFinite(kline.lowPrice) && kline.lowPrice < snapshot ? kline.lowPrice : null;
}

function isOnGuardedKline(kline: GuardKline, guard: EntryKlineGuardSnapshot): boolean {
  return guard.klineOpenTimestamp !== null && kline.openTimestamp === guard.klineOpenTimestamp;
}

function resolveFavourableDecisionPrice(args: ResolveDecisionPriceArgs): number {
  const { kline, direction, guard, offCandlePrice, onCandleFallbackPrice } = args;

  if (!isOnGuardedKline(kline, guard)) {
    return offCandlePrice;
  }

  const snapshot = direction === 'long' ? guard.highSnapshot : guard.lowSnapshot;
  const breakDirection = direction === 'long' ? 'above' : 'below';
  const guardedPrice = resolveGuardedExtremePrice({ kline, breakDirection, snapshot });

  return guardedPrice ?? onCandleFallbackPrice;
}

function resolveUnfavourableDecisionPrice(args: ResolveDecisionPriceArgs): number {
  const { kline, direction, guard, offCandlePrice, onCandleFallbackPrice } = args;

  if (!isOnGuardedKline(kline, guard)) {
    return offCandlePrice;
  }

  const snapshot = direction === 'long' ? guard.lowSnapshot : guard.highSnapshot;
  const breakDirection = direction === 'long' ? 'below' : 'above';
  const guardedPrice = resolveGuardedExtremePrice({ kline, breakDirection, snapshot });

  return guardedPrice ?? onCandleFallbackPrice;
}

function extractKlineHighLowSnapshot(kline: GuardKline | null): { high: number | null; low: number | null } {
  if (!kline) {
    return { high: null, low: null };
  }

  const high = Number.isFinite(kline.highPrice) && kline.highPrice > 0 ? kline.highPrice : null;
  const low = Number.isFinite(kline.lowPrice) && kline.lowPrice > 0 ? kline.lowPrice : null;

  return { high, low };
}

export {
  extractKlineHighLowSnapshot,
  resolveFavourableDecisionPrice,
  resolveGuardedExtremePrice,
  resolveUnfavourableDecisionPrice,
};
