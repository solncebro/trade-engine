import type { Kline, KlineInterval, MaValues } from '../types/index';

type MarketDataKlineListener = (symbol: string, kline: Kline, maValues: MaValues) => void;
type MarketDataTickListener = (symbol: string, kline: Kline) => void;
type MarketDataSymbolListener = (symbol: string) => void;
type MarketDataConnectionLostListener = (reason: string) => void;
type MarketDataConnectionRestoredListener = () => void;

interface MarketDataStaleSymbol {
  symbol: string;
  ageMs: number;
}

interface MarketDataSource {
  getInterval(): KlineInterval;
  getIntervalMs(): number;
  getMaValues(symbol: string): MaValues;
  getKlineList(symbol: string): Kline[];
  getCurrentKline(symbol: string): Kline | undefined;
  getSymbolList(): string[];
  getLastKlineOpenTimestamp(symbol: string): number | undefined;
  getLastUpdateTimestamp(symbol: string): number | undefined;
  getStaleSymbolList(): MarketDataStaleSymbol[];
  isStale?(): boolean;
  shutdown(): Promise<void>;
  on(eventName: 'klineClosed' | 'klineUpdated', listener: MarketDataKlineListener): this;
  on(eventName: 'klineUpdatedTick', listener: MarketDataTickListener): this;
  on(eventName: 'symbolAdded' | 'symbolRemoved', listener: MarketDataSymbolListener): this;
  on(eventName: 'connectionLost', listener: MarketDataConnectionLostListener): this;
  on(eventName: 'connectionRestored', listener: MarketDataConnectionRestoredListener): this;
  off(eventName: 'klineClosed' | 'klineUpdated', listener: MarketDataKlineListener): this;
  off(eventName: 'klineUpdatedTick', listener: MarketDataTickListener): this;
  off(eventName: 'symbolAdded' | 'symbolRemoved', listener: MarketDataSymbolListener): this;
  off(eventName: 'connectionLost', listener: MarketDataConnectionLostListener): this;
  off(eventName: 'connectionRestored', listener: MarketDataConnectionRestoredListener): this;
}

export type { MarketDataSource };
