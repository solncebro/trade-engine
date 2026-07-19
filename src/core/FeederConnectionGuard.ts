import { logger } from './logger';

import type { KlineInterval } from '../types/index';

// Tracks which feeder channels (by timeframe) currently have a lost connection to the market-data
// feeder. Consuming apps wire `wireFeederConnectionMonitoring` to mark a channel frozen on
// `connectionLost` and restored on `connectionRestored`, and their trade paths consult `isChannelFrozen`
// to refuse trading on a channel whose klines are stale until the feed recovers. Logging on state
// changes is idempotent — only a real freeze/unfreeze transition emits a line.
class FeederConnectionGuard {
  private readonly frozenChannelIntervalSet = new Set<KlineInterval>();

  markChannelFrozen(interval: KlineInterval): void {
    const wasFrozen = this.frozenChannelIntervalSet.has(interval);
    this.frozenChannelIntervalSet.add(interval);

    if (!wasFrozen) {
      logger.warn({ interval }, `[FeederConnectionGuard] Channel ${interval} FROZEN — trade actions blocked until feeder connection recovers`);
    }
  }

  markChannelRestored(interval: KlineInterval): void {
    const wasFrozen = this.frozenChannelIntervalSet.delete(interval);

    if (wasFrozen) {
      logger.info({ interval }, `[FeederConnectionGuard] Channel ${interval} UNFROZEN — trade actions resumed`);
    }
  }

  isChannelFrozen(interval: KlineInterval): boolean {
    return this.frozenChannelIntervalSet.has(interval);
  }

  getFrozenChannelList(): KlineInterval[] {
    return [...this.frozenChannelIntervalSet];
  }
}

export { FeederConnectionGuard };
