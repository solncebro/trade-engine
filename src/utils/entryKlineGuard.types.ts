import type { Kline } from '../types/index';

type GuardKline = Pick<Kline, 'openTimestamp' | 'highPrice' | 'lowPrice' | 'closePrice'>;

type GuardDirection = 'long' | 'short';

interface EntryKlineGuardSnapshot {
  klineOpenTimestamp: number | null;
  highSnapshot: number | null;
  lowSnapshot: number | null;
}

interface ResolveDecisionPriceArgs {
  kline: GuardKline;
  direction: GuardDirection;
  guard: EntryKlineGuardSnapshot;
  offCandlePrice: number;
  onCandleFallbackPrice: number;
}

interface ResolveGuardedExtremePriceArgs {
  kline: GuardKline;
  breakDirection: 'above' | 'below';
  snapshot: number | null;
}

export type { GuardKline, GuardDirection, EntryKlineGuardSnapshot, ResolveDecisionPriceArgs, ResolveGuardedExtremePriceArgs };
