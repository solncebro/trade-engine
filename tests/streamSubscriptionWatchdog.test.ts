import { StreamSubscriptionWatchdog } from '../src/services/streamSubscriptionWatchdog';
import type {
  StreamHealthEvent,
  StreamLastEntry,
  StreamRecoveryAttemptResult,
  StreamWatchdogStrategy,
} from '../src/services/streamSubscriptionWatchdog.types';

const T0 = 1_700_000_000_000;
const CHECK_INTERVAL_MS = 10_000;
const GRACE_MS = 5_000;
const COOLDOWN_MS = 30_000;
const FAIL_COOLDOWN_MS = 120_000;

type MockStrategy = StreamWatchdogStrategy & { recover: jest.Mock };

function createMockStrategy(
  recoverImpl?: (key: string) => Promise<StreamRecoveryAttemptResult>,
  suppressDuringRecovery = false,
): MockStrategy {
  const recover = jest.fn(
    recoverImpl ?? (async (key: string): Promise<StreamRecoveryAttemptResult> => ({ key, status: 'recovered', errorText: null })),
  );

  return {
    streamType: 'orderbook',
    suppressDuringRecovery,
    computeAgeMs: (entry: StreamLastEntry, nowMs: number): number => nowMs - entry.freshnessTimestamp,
    recover,
  };
}

function buildWatchdog(strategy: StreamWatchdogStrategy, callbacks = {}): StreamSubscriptionWatchdog {
  return new StreamSubscriptionWatchdog({
    clientLabel: 'TestExchange',
    strategy,
    config: {
      checkIntervalMs: CHECK_INTERVAL_MS,
      graceMs: GRACE_MS,
      recoveryCooldownMs: COOLDOWN_MS,
      recoveryFailCooldownMs: FAIL_COOLDOWN_MS,
      recoveryFailCountThreshold: 2,
      restInterCallMs: 0,
      parallelismLimit: 4,
    },
    callbacks,
  });
}

describe('StreamSubscriptionWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('does not flag a fresh subscription as overdue within grace', async () => {
    const strategy = createMockStrategy();
    const watchdog = buildWatchdog(strategy);

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    // Feed freshness just before the first scan fires → age at scan ≈ 100ms < grace.
    watchdog.recordFreshness('BTCUSDT:200', T0 + CHECK_INTERVAL_MS - 100);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(strategy.recover).not.toHaveBeenCalled();
    watchdog.stop();
  });

  test('recovers an overdue subscription and fires stale + recovered events', async () => {
    const staleEventList: StreamHealthEvent[] = [];
    const recoveredEventList: StreamHealthEvent[] = [];
    const strategy = createMockStrategy();
    const watchdog = buildWatchdog(strategy, {
      onStreamStale: (event: StreamHealthEvent) => staleEventList.push(event),
      onStreamRecovered: (event: StreamHealthEvent) => recoveredEventList.push(event),
    });

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(strategy.recover).toHaveBeenCalledWith('BTCUSDT:200', expect.anything());
    expect(staleEventList).toHaveLength(1);
    expect(staleEventList[0]).toMatchObject({ streamType: 'orderbook', key: 'BTCUSDT:200' });
    expect(recoveredEventList).toHaveLength(1);
    expect(recoveredEventList[0]).toMatchObject({ key: 'BTCUSDT:200' });
    watchdog.stop();
  });

  test('recordFreshness keeps a busy subscription out of recovery', async () => {
    const strategy = createMockStrategy();
    const watchdog = buildWatchdog(strategy);

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    // Feed freshness just before each scan fires → stays within grace every tick.
    for (let i = 1; i <= 3; i += 1) {
      watchdog.recordFreshness('BTCUSDT:200', T0 + i * CHECK_INTERVAL_MS - 100);
      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    }

    expect(strategy.recover).not.toHaveBeenCalled();
    watchdog.stop();
  });

  test('respects cooldown between recovery attempts', async () => {
    const strategy = createMockStrategy();
    const watchdog = buildWatchdog(strategy);

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    // first overdue scan → recover #1 (seeds freshness to now)
    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(strategy.recover).toHaveBeenCalledTimes(1);

    // advance just past grace again (still within cooldown) → no second attempt
    const afterFirst = T0 + GRACE_MS + CHECK_INTERVAL_MS + 1;
    jest.setSystemTime(afterFirst + GRACE_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(strategy.recover).toHaveBeenCalledTimes(1);

    // advance beyond cooldown + grace → second attempt
    jest.setSystemTime(afterFirst + COOLDOWN_MS + GRACE_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(strategy.recover).toHaveBeenCalledTimes(2);
    watchdog.stop();
  });

  test('fires recovery-failed event and escalates fail count on failure', async () => {
    const failedEventList: StreamHealthEvent[] = [];
    const strategy = createMockStrategy(async (key: string) => ({ key, status: 'failed', errorText: 'boom' }));
    const watchdog = buildWatchdog(strategy, {
      onStreamRecoveryFailed: (event: StreamHealthEvent) => failedEventList.push(event),
    });

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(failedEventList).toHaveLength(1);
    expect(failedEventList[0]).toMatchObject({ key: 'BTCUSDT:200', errorText: 'boom' });
    watchdog.stop();
  });

  test('a throwing recover is treated as failed, not fatal', async () => {
    const failedEventList: StreamHealthEvent[] = [];
    const strategy = createMockStrategy(async () => {
      throw new Error('strategy threw');
    });
    const watchdog = buildWatchdog(strategy, {
      onStreamRecoveryFailed: (event: StreamHealthEvent) => failedEventList.push(event),
    });

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(failedEventList).toHaveLength(1);
    expect(failedEventList[0].errorText).toContain('strategy threw');
    watchdog.stop();
  });

  test('unregisterKey stops tracking the subscription', async () => {
    const strategy = createMockStrategy();
    const watchdog = buildWatchdog(strategy);

    watchdog.registerKey('BTCUSDT:200');
    watchdog.unregisterKey('BTCUSDT:200');
    watchdog.start();

    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(strategy.recover).not.toHaveBeenCalled();
    watchdog.stop();
  });

  test('suppresses incoming events during a replay-style recovery', async () => {
    let resolveRecover: (() => void) | undefined;
    const strategy = createMockStrategy(
      (key: string) =>
        new Promise<StreamRecoveryAttemptResult>((resolve) => {
          resolveRecover = (): void => resolve({ key, status: 'recovered', errorText: null });
        }),
      true,
    );
    const watchdog = buildWatchdog(strategy);

    watchdog.registerKey('BTCUSDT:200');
    watchdog.start();

    // The interval callback kicks off runScan fire-and-forget, so advancing the
    // timer resolves while recover() is still pending → key is suppressed.
    jest.setSystemTime(T0 + GRACE_MS + CHECK_INTERVAL_MS + 1);
    await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(watchdog.isSuppressed('BTCUSDT:200')).toBe(true);

    resolveRecover?.();

    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(watchdog.isSuppressed('BTCUSDT:200')).toBe(false);
    watchdog.stop();
  });
});
