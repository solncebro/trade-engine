import type { SequentialQueue, SequentialQueueArgs } from './sequentialQueue.types';

import { logger as libraryLogger } from '../core/logger';

const DEFAULT_SLOW_TASK_LOG_MS = 500;

/**
 * A sequential background queue for "tell and record" work. The hot path emits and returns at once;
 * rendering a chart, talking to Telegram and writing rows happen HERE, one at a time, in enqueue order.
 * Ported from rubber (the entry used to wait 725ms for a chart render before the strategy saw the
 * kline, VELVETUSDT 14.08.2026). Unlike `PerKeySerializer`, the caller never awaits a task.
 */
export function createSequentialQueue(args: SequentialQueueArgs): SequentialQueue {
  const { label, beforeTask } = args;
  const logger = args.logger ?? libraryLogger;
  const slowTaskLogMs = args.slowTaskLogMs ?? DEFAULT_SLOW_TASK_LOG_MS;
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return {
    enqueue: (taskLabel: string, task: () => Promise<void>): void => {
      pendingCount += 1;
      tail = tail.then(async () => {
        try {
          if (beforeTask !== undefined) {
            await beforeTask();
          }
        } catch (error: unknown) {
          logger.warn(`[${label}] yield hook failed before "${taskLabel}": ${String(error)}`);
        }

        const startedAtMs = Date.now();

        try {
          await task();
        } catch (error: unknown) {
          logger.error(`[${label}] task "${taskLabel}" failed: ${String(error)}`);
        } finally {
          pendingCount -= 1;

          const tookMs = Date.now() - startedAtMs;

          if (tookMs >= slowTaskLogMs) {
            logger.info(`[${label}] task "${taskLabel}" took ${tookMs}ms`);
          }
        }
      });
    },

    drain: (): Promise<void> => tail,

    size: (): number => pendingCount,
  };
}
