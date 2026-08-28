import { logger } from './logger';
import type { RateLimitedRequestQueueArgs } from './RateLimitedRequestQueue.types';

import { sleep } from '../utils/sleep';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_LOGGER_LABEL = '[RateLimit]';
const THROTTLE_LOG_WINDOW_MS = 60_000;

export class RateLimitedRequestQueue {
  private readonly rateLimit: number;
  private readonly intervalMs: number;
  private readonly loggerLabel: string;
  private readonly timestampList: number[] = [];
  private chainTail: Promise<unknown> = Promise.resolve();
  private lastThrottleLogAtMs: number = 0;

  constructor(args: RateLimitedRequestQueueArgs) {
    if (args.rateLimit <= 0 || !Number.isFinite(args.rateLimit)) {
      throw new Error(`RateLimitedRequestQueue requires positive rateLimit, got ${args.rateLimit}`);
    }
    this.rateLimit = Math.floor(args.rateLimit);
    this.intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.loggerLabel = args.loggerLabel ?? DEFAULT_LOGGER_LABEL;
  }

  public async execute<T>(fn: () => Promise<T>, contextLabel?: string): Promise<T> {
    const slotPromise = this.chainTail.then(() => this.waitForSlot(contextLabel));
    this.chainTail = slotPromise.catch(() => undefined);
    await slotPromise;
    return fn();
  }

  public getRateLimit(): number {
    return this.rateLimit;
  }

  public getIntervalMs(): number {
    return this.intervalMs;
  }

  private async waitForSlot(contextLabel?: string): Promise<void> {
    while (true) {
      const now = Date.now();
      const windowStart = now - this.intervalMs;
      while (this.timestampList.length > 0 && this.timestampList[0] <= windowStart) {
        this.timestampList.shift();
      }

      if (this.timestampList.length < this.rateLimit) {
        this.timestampList.push(now);
        return;
      }

      const oldestTimestamp = this.timestampList[0];
      const waitMs = oldestTimestamp + this.intervalMs - now;

      if (now - this.lastThrottleLogAtMs >= THROTTLE_LOG_WINDOW_MS) {
        this.lastThrottleLogAtMs = now;
        logger.info(
          {
            rateLimit: this.rateLimit,
            intervalMs: this.intervalMs,
            waitMs,
            contextLabel,
          },
          `${this.loggerLabel} Throttling active — rateLimit=${this.rateLimit}/${this.intervalMs}ms${contextLabel ? ` context=${contextLabel}` : ''}`
        );
      }

      await sleep(Math.max(1, waitMs));
    }
  }
}
