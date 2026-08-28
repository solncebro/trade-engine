import type { ExchangeClient } from '@solncebro/exchange-engine';

import type {
  StreamLastEntry,
  StreamRecoveryAttemptResult,
  StreamType,
  StreamWatchdogStrategy,
} from './streamSubscriptionWatchdog.types';

import { logger } from '../core/logger';

const LOG_PREFIX = '[StreamWatchdogStrategy]';

// mark-price is connection-granular (tickers.{symbol} is a shared topic-set with
// no per-symbol mark-price subscribe), so it is tracked under a single key.
export const MARK_PRICE_WATCHDOG_KEY = 'markPrice';

export function buildOrderbookWatchdogKey(symbol: string, depth: number): string {
  return `${symbol}:${depth}`;
}

export function buildPublicTradeWatchdogKey(symbol: string): string {
  return symbol;
}

/**
 * Heartbeat-based staleness (overdue when no event arrived for > graceMs) with
 * resubscribe-only recovery (no REST replay → no suppression needed). One class
 * for orderbook / publicTrade / mark-price: the three differ ONLY in the stream
 * type label and the resubscribe call, which the named subclasses below supply.
 */
class HeartbeatResubscribeStrategy implements StreamWatchdogStrategy {
  public readonly suppressDuringRecovery = false;

  public constructor(
    public readonly streamType: StreamType,
    protected readonly client: ExchangeClient,
    protected readonly clientLabel: string,
    private readonly resubscribe: (client: ExchangeClient, key: string) => void
  ) {}

  public computeAgeMs(entry: StreamLastEntry, nowMs: number): number {
    return nowMs - entry.freshnessTimestamp;
  }

  public async recover(key: string): Promise<StreamRecoveryAttemptResult> {
    try {
      this.resubscribe(this.client, key);
      logger.info({ key }, `${LOG_PREFIX} ${this.clientLabel} ${this.streamType} resubscribe ${key}`);

      return { key, status: 'recovered', errorText: null };
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      logger.error({ error, key }, `${LOG_PREFIX} ${this.clientLabel} ${this.streamType} resubscribe failed for ${key}`);

      return { key, status: 'failed', errorText };
    }
  }
}

export class OrderbookWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public constructor(client: ExchangeClient, clientLabel: string) {
    super('orderbook', client, clientLabel, (streamClient, key) => {
      const separatorIndex = key.lastIndexOf(':');

      streamClient.resubscribeOrderbook({ symbol: key.slice(0, separatorIndex), depth: Number(key.slice(separatorIndex + 1)) });
    });
  }
}

export class PublicTradeWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public constructor(client: ExchangeClient, clientLabel: string) {
    super('publicTrade', client, clientLabel, (streamClient, key) => streamClient.resubscribePublicTrades({ symbol: key }));
  }
}

export class MarkPriceWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public constructor(client: ExchangeClient, clientLabel: string) {
    super('markPrice', client, clientLabel, streamClient => streamClient.resubscribeMarkPrices());
  }
}
