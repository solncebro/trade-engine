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
 * resubscribe-only recovery (no REST replay → no suppression needed). Shared by
 * the orderbook / publicTrade / mark-price strategies; only the resubscribe call
 * differs per stream type.
 */
abstract class HeartbeatResubscribeStrategy implements StreamWatchdogStrategy {
  public abstract readonly streamType: StreamType;
  public readonly suppressDuringRecovery = false;

  protected constructor(
    protected readonly client: ExchangeClient,
    protected readonly clientLabel: string,
  ) {}

  public computeAgeMs(entry: StreamLastEntry, nowMs: number): number {
    return nowMs - entry.freshnessTimestamp;
  }

  public async recover(key: string): Promise<StreamRecoveryAttemptResult> {
    try {
      this.doResubscribe(key);
      logger.info({ key }, `${LOG_PREFIX} ${this.clientLabel} ${this.streamType} resubscribe ${key}`);

      return { key, status: 'recovered', errorText: null };
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      logger.error({ error, key }, `${LOG_PREFIX} ${this.clientLabel} ${this.streamType} resubscribe failed for ${key}`);

      return { key, status: 'failed', errorText };
    }
  }

  protected abstract doResubscribe(key: string): void;
}

export class OrderbookWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public readonly streamType: StreamType = 'orderbook';

  public constructor(client: ExchangeClient, clientLabel: string) {
    super(client, clientLabel);
  }

  protected doResubscribe(key: string): void {
    const separatorIndex = key.lastIndexOf(':');
    const symbol = key.slice(0, separatorIndex);
    const depth = Number(key.slice(separatorIndex + 1));

    this.client.resubscribeOrderbook({ symbol, depth });
  }
}

export class PublicTradeWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public readonly streamType: StreamType = 'publicTrade';

  public constructor(client: ExchangeClient, clientLabel: string) {
    super(client, clientLabel);
  }

  protected doResubscribe(key: string): void {
    this.client.resubscribePublicTrades({ symbol: key });
  }
}

export class MarkPriceWatchdogStrategy extends HeartbeatResubscribeStrategy {
  public readonly streamType: StreamType = 'markPrice';

  public constructor(client: ExchangeClient, clientLabel: string) {
    super(client, clientLabel);
  }

  protected doResubscribe(_key: string): void {
    this.client.resubscribeMarkPrices();
  }
}
