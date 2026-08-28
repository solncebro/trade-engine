import type { ExchangeClient, KlineInterval } from '@solncebro/exchange-engine';

export interface KlineWatchdogStrategyArgs {
  client: ExchangeClient;
  clientLabel: string;
  restRefetchLimit?: number;
  restTimeoutMs?: number;
  // Intervals that get a whole extra interval of grace: a quiet symbol may legitimately
  // skip one kline, and shouting on the first miss produced false alarms.
  graceScaledIntervalList?: KlineInterval[];
  // Prefix for symbols the consumer wants highlighted in the overdue message (e.g. an
  // emoji for symbols with a live position); empty string = no highlight.
  symbolMarker?: (symbol: string, interval: KlineInterval) => string;
}
