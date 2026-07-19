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
export class LogThrottle {
  private readonly lastLoggedAtMsByKey: Map<string, number> = new Map();
  private readonly droppedCountByKey: Map<string, number> = new Map();

  public shouldLog(key: string, windowMs: number): boolean {
    const nowMs = Date.now();
    const lastLoggedAtMs = this.lastLoggedAtMsByKey.get(key);

    if (lastLoggedAtMs === undefined || nowMs - lastLoggedAtMs >= windowMs) {
      this.lastLoggedAtMsByKey.set(key, nowMs);

      return true;
    }

    this.droppedCountByKey.set(key, (this.droppedCountByKey.get(key) ?? 0) + 1);

    return false;
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
