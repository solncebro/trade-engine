import type { ExchangeClient, OrderBookLevel } from '@solncebro/exchange-engine';

/** A live, merged order book: numeric levels, asks ascending, bids descending. */
export interface LiveOrderBook {
  symbol: string;
  askList: ReadonlyArray<OrderBookLevel>;
  bidList: ReadonlyArray<OrderBookLevel>;
  updateId: number;
  /** Exchange-side time of the last applied frame. */
  eventTimestamp: number;
  /** Local time the last frame arrived. */
  receivedTimestamp: number;
}

export interface OrderBookTrackerArgs {
  /** Stream client to subscribe through — the watchdog-proxied one, so recovery wraps the handler. */
  client: ExchangeClient;
  /** Stream depth (levels per side) the exchange serves; see `resolveOrderBookStreamDepth`. */
  depth: number;
  /** Human label for logs, e.g. `Binance Futures`. */
  clientLabel: string;
  /** Min gap between two resubscriptions of one symbol after sequence gaps. */
  resubscribeDebounceMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}
