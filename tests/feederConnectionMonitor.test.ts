import { EventEmitter } from 'events';

import { FeederConnectionGuard } from '../src/core/FeederConnectionGuard';
import type { MarketDataSource } from '../src/core/marketDataSource.types';
import type { TelegramNotifier } from '../src/services/telegramNotifier';
import type { KlineInterval } from '../src/types/index';
import { wireFeederConnectionMonitoring } from '../src/utils/feederConnectionMonitor';

class FakeSource extends EventEmitter {
  public stale = false;

  constructor(private readonly interval: KlineInterval) {
    super();
  }

  getInterval(): KlineInterval {
    return this.interval;
  }

  isStale(): boolean {
    return this.stale;
  }
}

function createFakeNotifier(): { notifier: TelegramNotifier; messageList: string[] } {
  const messageList: string[] = [];
  const notifier = {
    sendMessage: async (message: string): Promise<void> => {
      messageList.push(message);
    },
  } as unknown as TelegramNotifier;

  return { notifier, messageList };
}

const STALE_INTERVAL_MS = 1_000;

describe('wireFeederConnectionMonitoring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('freezes a channel and alerts on connectionLost, unfreezes and alerts on connectionRestored', () => {
    const guard = new FeederConnectionGuard();
    const source = new FakeSource('30m');
    const { notifier, messageList } = createFakeNotifier();

    const handle = wireFeederConnectionMonitoring({
      sources: [source as unknown as MarketDataSource],
      guard,
      telegramNotifier: notifier,
      appLabel: 'Volume Breaker',
      exchangeLabel: 'Binance',
      staleWatchdogIntervalMs: STALE_INTERVAL_MS,
    });

    source.emit('connectionLost', 'socket closed');
    expect(guard.isChannelFrozen('30m')).toBe(true);
    expect(messageList[0]).toContain('feeder channel 30m DOWN');

    source.emit('connectionRestored');
    expect(guard.isChannelFrozen('30m')).toBe(false);
    expect(messageList[1]).toContain('feeder channel 30m RESTORED');

    handle.stop();
  });

  it('alerts on a stale non-frozen channel and stays silent for a frozen one', () => {
    const guard = new FeederConnectionGuard();
    const source = new FakeSource('30m');
    const { notifier, messageList } = createFakeNotifier();

    const handle = wireFeederConnectionMonitoring({
      sources: [source as unknown as MarketDataSource],
      guard,
      telegramNotifier: notifier,
      appLabel: 'MA Chaser',
      exchangeLabel: 'Bybit',
      staleWatchdogIntervalMs: STALE_INTERVAL_MS,
    });

    // Stale + not frozen → one STALE alert.
    source.stale = true;
    jest.advanceTimersByTime(STALE_INTERVAL_MS);
    expect(messageList.filter((message) => message.includes('STALE/DOWN'))).toHaveLength(1);

    // Frozen channel is skipped by the watchdog (no second STALE alert).
    guard.markChannelFrozen('30m');
    jest.advanceTimersByTime(STALE_INTERVAL_MS);
    expect(messageList.filter((message) => message.includes('STALE/DOWN'))).toHaveLength(1);

    handle.stop();
  });

  it('does not alert when the channel is healthy', () => {
    const guard = new FeederConnectionGuard();
    const source = new FakeSource('5m');
    const { notifier, messageList } = createFakeNotifier();

    const handle = wireFeederConnectionMonitoring({
      sources: [source as unknown as MarketDataSource],
      guard,
      telegramNotifier: notifier,
      appLabel: 'Rubber',
      exchangeLabel: 'Binance',
      staleWatchdogIntervalMs: STALE_INTERVAL_MS,
    });

    jest.advanceTimersByTime(STALE_INTERVAL_MS * 3);
    expect(messageList).toHaveLength(0);

    handle.stop();
  });
});
