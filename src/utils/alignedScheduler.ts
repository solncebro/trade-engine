import type {
  AlignedSchedulerArgs,
  AlignedSchedulerHandle,
  NextAlignedTickArgs,
} from './alignedScheduler.types';

import { logger } from '../core/logger';

const DEFAULT_CONTEXT_LABEL = '[AlignedScheduler] tick failed';

/**
 * A timer may fire a hair BEFORE the instant it was set for (timer rounding, a clock nudged by time
 * sync). Rearming from such a reading finds the very same mark still ahead and fires on it a SECOND
 * time: on 13.08.2026 rubber's open-interest prefetch ran twice for the 15:30 bucket, 32 ms apart.
 * Anything this close is treated as already served.
 */
const REARM_GUARD_MS = 1000;

/**
 * Milliseconds from `nowMs` until the next moment sitting `leadMs` before the end of a `periodMs`
 * window on the wall clock. With a half-hour period and a 30-second lead that is :29:30 and :59:30,
 * whatever time the process started — a plain repeating interval drifts to an arbitrary offset instead.
 */
export function millisecondsUntilNextAlignedTick(args: NextAlignedTickArgs): number {
  const { nowMs, periodMs, leadMs } = args;
  const guardMs = args.guardMs ?? 0;
  const offsetInPeriod = nowMs % periodMs;
  const targetOffset = periodMs - leadMs;
  const delay = targetOffset - offsetInPeriod;

  return delay > guardMs ? delay : delay + periodMs;
}

/** Fire `tickHandler` at a fixed offset before the end of every wall-clock window, re-arming each time
 *  from the clock (never from the previous firing) so a slow tick cannot drag the schedule with it.
 *  For a plain "every N ms" loop use `startIntervalScheduler`. */
export function startAlignedScheduler(args: AlignedSchedulerArgs): AlignedSchedulerHandle {
  let timer: NodeJS.Timeout | null = null;
  let isStopped = false;
  const handleError = args.errorHandler ?? ((error: unknown): void => {
    logger.error({ error }, args.contextLabel ?? DEFAULT_CONTEXT_LABEL);
  });

  // The guard applies to REARMING only: the very first arming happens at an arbitrary moment of the
  // window, so a mark half a second away there is a genuine one worth hitting.
  const arm = (guardMs: number): void => {
    if (isStopped) {
      return;
    }

    const delayMs = millisecondsUntilNextAlignedTick({ nowMs: Date.now(), periodMs: args.periodMs, leadMs: args.leadMs, guardMs });

    timer = setTimeout(() => {
      arm(REARM_GUARD_MS);

      try {
        const result = args.tickHandler();

        if (result instanceof Promise) {
          result.catch(handleError);
        }
      } catch (error: unknown) {
        handleError(error);
      }
    }, delayMs);
    timer.unref();
  };

  arm(0);

  return {
    stop: () => {
      isStopped = true;

      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}
