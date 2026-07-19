type LogThrottleLevel = 'info' | 'warn' | 'error';

interface ThrottledLoggerLike {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface ThrottledLogArgs {
  logger: ThrottledLoggerLike;
  level: LogThrottleLevel;
  key: string;
  windowMs: number;
  payload?: Record<string, unknown>;
  message: string;
}

/**
 * Per-key time-window log throttle. Generalises the suppression-relog pattern
 * (one log per window per key) and aggregates the number of suppressed repeats
 * so the next allowed emission can report how many were dropped.
 *
 * Bounds the worst-case log volume of any high-frequency call site: at most one
 * line per `windowMs` per `key`, regardless of how often it fires.
 */
const MAX_TRACKED_KEY_COUNT = 5_000;

export class LogThrottle {
  private readonly lastLoggedAtMsByKey: Map<string, number> = new Map();
  private readonly droppedCountByKey: Map<string, number> = new Map();

  public shouldLog(key: string, windowMs: number): boolean {
    const nowMs = Date.now();
    const lastLoggedAtMs = this.lastLoggedAtMsByKey.get(key);

    if (lastLoggedAtMs === undefined || nowMs - lastLoggedAtMs >= windowMs) {
      if (lastLoggedAtMs === undefined && this.lastLoggedAtMsByKey.size >= MAX_TRACKED_KEY_COUNT) {
        this.evictOldestKeys();
      }

      this.lastLoggedAtMsByKey.set(key, nowMs);

      return true;
    }

    this.droppedCountByKey.set(key, (this.droppedCountByKey.get(key) ?? 0) + 1);

    return false;
  }

  // Long-lived processes accumulate per-orderId / per-chaserId keys forever
  // (every trail mints a new orderId). Cap the map: when full, drop the oldest
  // half by last-log time — losing a stale throttle window only means one extra
  // log line for a key that has been silent the longest.
  private evictOldestKeys(): void {
    const sortedEntryList = [...this.lastLoggedAtMsByKey.entries()].sort((a, b) => a[1] - b[1]);
    const evictCount = Math.floor(sortedEntryList.length / 2);

    for (let entryIndex = 0; entryIndex < evictCount; entryIndex += 1) {
      const [key] = sortedEntryList[entryIndex];
      this.lastLoggedAtMsByKey.delete(key);
      this.droppedCountByKey.delete(key);
    }
  }

  // Removes every tracked key with the given prefix — call on entity teardown
  // (e.g. chaser deletion) so its per-entity keys do not linger until eviction.
  public clearByKeyPrefix(keyPrefix: string): void {
    for (const key of this.lastLoggedAtMsByKey.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.lastLoggedAtMsByKey.delete(key);
        this.droppedCountByKey.delete(key);
      }
    }
  }

  public takeDroppedCount(key: string): number {
    const droppedCount = this.droppedCountByKey.get(key) ?? 0;
    this.droppedCountByKey.delete(key);

    return droppedCount;
  }

  public throttled(args: ThrottledLogArgs): void {
    const { logger, level, key, windowMs, payload, message } = args;

    if (!this.shouldLog(key, windowMs)) {
      return;
    }

    const droppedCount = this.takeDroppedCount(key);
    const suffix = droppedCount > 0
      ? ` (+${droppedCount} similar suppressed in last ${Math.round(windowMs / 1000)}s)`
      : '';

    logger[level](payload ?? {}, `${message}${suffix}`);
  }
}
