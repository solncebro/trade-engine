import { millisecondsUntilNextAlignedTick, startAlignedScheduler } from '../src/utils/alignedScheduler';

const HALF_HOUR = 30 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;
const MINUTE = 60 * 1000;

/** Wall-clock milliseconds for a given minute and second past a half-hour boundary. */
function at(minute: number, second: number): number {
  return HALF_HOUR * 100 + minute * MINUTE + second * 1000;
}

describe('millisecondsUntilNextAlignedTick', () => {
  it('lands on :29:30 from earlier in the window', () => {
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(0, 0), periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS })).toBe(29.5 * MINUTE);
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(20, 0), periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS })).toBe(9.5 * MINUTE);
  });

  // Past the mark, the next one is a full window away — never zero, which would spin.
  it('rolls over to the next window when the mark has just passed', () => {
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(29, 30), periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS })).toBe(HALF_HOUR);
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(29, 45), periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS })).toBe(HALF_HOUR - 15 * 1000);
  });

  it('always waits a positive time, whatever moment it is asked at', () => {
    for (let second = 0; second < HALF_HOUR / 1000; second += 7) {
      const delay = millisecondsUntilNextAlignedTick({ nowMs: HALF_HOUR * 3 + second * 1000, periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS });

      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(HALF_HOUR);
    }
  });

  // The 13.08.2026 double prefetch: the timer fired 32 ms before its own mark, and rearming without a
  // guard aimed at that very mark again.
  it('skips a mark that is closer than the guard instead of firing on it twice', () => {
    const justBeforeTheMark = at(29, 45) - 32;

    expect(millisecondsUntilNextAlignedTick({ nowMs: justBeforeTheMark, periodMs: HALF_HOUR, leadMs: 15 * 1000, guardMs: 1000 })).toBe(HALF_HOUR + 32);
    expect(millisecondsUntilNextAlignedTick({ nowMs: justBeforeTheMark, periodMs: HALF_HOUR, leadMs: 15 * 1000 })).toBe(32);
  });

  it('leaves a mark further away than the guard alone', () => {
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(29, 43), periodMs: HALF_HOUR, leadMs: 15 * 1000, guardMs: 1000 })).toBe(2000);
  });

  it('aims a full window ahead when rearmed just after an on-time tick', () => {
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(29, 45) + 5, periodMs: HALF_HOUR, leadMs: 15 * 1000, guardMs: 1000 })).toBe(HALF_HOUR - 5);
  });

  it('fires AFTER the window end when the lead is negative', () => {
    expect(millisecondsUntilNextAlignedTick({ nowMs: at(29, 0), periodMs: HALF_HOUR, leadMs: -MINUTE })).toBe(2 * MINUTE);
  });
});

describe('startAlignedScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(at(29, 0));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires on every aligned mark and stops cleanly', () => {
    const tickHandler = jest.fn();
    const handle = startAlignedScheduler({ tickHandler, periodMs: HALF_HOUR, leadMs: THIRTY_SECONDS, errorHandler: jest.fn() });

    jest.advanceTimersByTime(30 * 1000 - 1);
    expect(tickHandler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(tickHandler).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(HALF_HOUR);
    expect(tickHandler).toHaveBeenCalledTimes(2);

    handle.stop();
    jest.advanceTimersByTime(HALF_HOUR * 3);
    expect(tickHandler).toHaveBeenCalledTimes(2);
  });

  it('routes a thrown and a rejected tick to the error handler and keeps the schedule', async () => {
    const errorHandler = jest.fn();
    let callCount = 0;
    const handle = startAlignedScheduler({
      tickHandler: () => {
        callCount += 1;

        if (callCount === 1) {
          throw new Error('sync boom');
        }

        return Promise.reject(new Error('async boom'));
      },
      periodMs: HALF_HOUR,
      leadMs: THIRTY_SECONDS,
      errorHandler,
    });

    jest.advanceTimersByTime(30 * 1000);
    jest.advanceTimersByTime(HALF_HOUR);
    await Promise.resolve();

    expect(callCount).toBe(2);
    expect(errorHandler).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
