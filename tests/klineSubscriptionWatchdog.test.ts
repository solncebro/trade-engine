import type { ExchangeClient, Kline, KlineInterval } from '@solncebro/exchange-engine';

import { KlineSubscriptionWatchdog } from '../src/services/klineSubscriptionWatchdog';

jest.mock('../src/core/logger', () => ({
  logger: {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

interface MockedClient extends ExchangeClient {
  fetchKlines: jest.Mock;
  resubscribeKlines: jest.Mock;
  subscribeKlines: jest.Mock;
  unsubscribeKlines: jest.Mock;
}

const T0 = 1_700_000_000_000;
const FIVE_MIN_MS = 300_000;

function buildKline(openTimestamp: number, isClosed: boolean = true): Kline {
  return {
    openTimestamp,
    openPrice: 1,
    highPrice: 1,
    lowPrice: 1,
    closePrice: 1,
    volume: 1,
    closeTimestamp: openTimestamp + FIVE_MIN_MS,
    quoteAssetVolume: 1,
    numberOfTrades: 1,
    takerBuyBaseAssetVolume: 1,
    takerBuyQuoteAssetVolume: 1,
    isClosed,
  };
}

function createMockClient(): MockedClient {
  const stub = (): unknown => undefined;

  const client = {
    apiKey: 'mock-key',
    tradeSymbols: new Map(),
    loadTradeSymbols: jest.fn(),
    fetchTickers: jest.fn(),
    fetchKlines: jest.fn(),
    fetchAllKlines: jest.fn(),
    fetchBalances: jest.fn(),
    fetchFundingRateHistory: jest.fn(),
    fetchPosition: jest.fn(),
    setLeverage: jest.fn(),
    setMarginMode: jest.fn(),
    amountToPrecision: jest.fn(),
    priceToPrecision: jest.fn(),
    getMinOrderQty: jest.fn(),
    getMinNotional: jest.fn(),
    fetchFundingInfo: jest.fn(),
    fetchPositionMode: jest.fn(),
    createOrderWebSocket: jest.fn(),
    fetchOrderHistory: jest.fn(),
    isTradeWebSocketConnected: jest.fn(),
    connectTradeWebSocket: jest.fn(),
    getWebSocketConnectionInfoList: jest.fn(),
    close: jest.fn(),
    cancelOrder: jest.fn(),
    getOrder: jest.fn(),
    fetchOpenOrders: jest.fn(),
    modifyOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    createBatchOrders: jest.fn(),
    cancelBatchOrders: jest.fn(),
    fetchOrderBook: jest.fn(),
    fetchTrades: jest.fn(),
    fetchMarkPrice: jest.fn(),
    fetchOpenInterest: jest.fn(),
    fetchFeeRate: jest.fn(),
    fetchIncome: jest.fn(),
    fetchClosedPnl: jest.fn(),
    setPositionMode: jest.fn(),
    watchTickers: stub as unknown as () => AsyncGenerator<unknown>,
    subscribeKlines: jest.fn(),
    unsubscribeKlines: jest.fn(),
    resubscribeKlines: jest.fn(),
    subscribeMarkPrices: jest.fn(),
    unsubscribeMarkPrices: jest.fn(),
    awaitWebSocketConnectionsReady: jest.fn(),
    connectUserDataStream: jest.fn(),
    disconnectUserDataStream: jest.fn(),
    isUserDataStreamConnected: jest.fn(),
  } as unknown as MockedClient;

  return client;
}

describe('KlineSubscriptionWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('wrapHandler updates lastKlineByKey on each kline event and forwards to user handler', () => {
    const client = createMockClient();
    const watchdog = new KlineSubscriptionWatchdog({ client, clientLabel: 'test' });
    const userHandler = jest.fn();

    const wrapped = watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);
    const kline = buildKline(T0);

    wrapped('BTCUSDT', kline);

    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', kline);
    expect(watchdog.getDiagnosticInfo().totalSubscriptions).toBe(1);
  });

  test('wrapHandler swallows user handler errors', () => {
    const client = createMockClient();
    const watchdog = new KlineSubscriptionWatchdog({ client, clientLabel: 'test' });
    const userHandler = jest.fn(() => {
      throw new Error('user code failure');
    });

    const wrapped = watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);
    const kline = buildKline(T0);

    expect(() => wrapped('BTCUSDT', kline)).not.toThrow();
    expect(userHandler).toHaveBeenCalled();
  });

  test('runScan triggers resubscribe + fetchKlines + replay + onNotify when overdue', async () => {
    const client = createMockClient();

    const replayKlineList = [
      buildKline(T0 + FIVE_MIN_MS),
      buildKline(T0 + 2 * FIVE_MIN_MS),
      buildKline(T0 + 3 * FIVE_MIN_MS, false),
    ];
    client.fetchKlines.mockResolvedValue(replayKlineList);

    const onNotify = jest.fn();
    const userHandler = jest.fn();

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 5, restRefetchLimit: 100 },
      onNotify,
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(client.resubscribeKlines).toHaveBeenCalledWith({ symbol: 'BTCUSDT', interval: '5m' });
    expect(client.fetchKlines).toHaveBeenCalledWith('BTCUSDT', '5m', { limit: 100 });
    expect(userHandler).toHaveBeenCalledTimes(replayKlineList.length);
    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', replayKlineList[0]);
    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', replayKlineList[2]);

    expect(onNotify).toHaveBeenCalledTimes(2);
    const overdueMessage = onNotify.mock.calls[0][0] as string;
    expect(overdueMessage).toContain('subscriptions overdue');
    expect(overdueMessage).toContain('1 total');
    expect(overdueMessage).toMatch(/5m — Lag \d+s \(1 symbols\)/);
    expect(overdueMessage).toContain('BTCUSDT');

    const recoveryMessage = onNotify.mock.calls[1][0] as string;
    expect(recoveryMessage).toContain('Kline recovery complete');
    expect(recoveryMessage).toContain('1 symbols');
    expect(recoveryMessage).toContain('5m (1 symbols)');
    expect(recoveryMessage).toContain('BTCUSDT');
    expect(recoveryMessage).not.toContain('klines refetched');

    watchdog.stop();
  });

  test('fires onStreamStale + onStreamRecovered on successful recovery', async () => {
    const client = createMockClient();
    client.fetchKlines.mockResolvedValue([buildKline(T0 + FIVE_MIN_MS)]);

    const onStreamStale = jest.fn();
    const onStreamRecovered = jest.fn();
    const onStreamRecoveryFailed = jest.fn();

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, onStreamStale, onStreamRecovered, onStreamRecoveryFailed },
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());
    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(onStreamStale).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTCUSDT', interval: '5m' }));
    expect(onStreamRecovered).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTCUSDT', interval: '5m' }));
    expect(onStreamRecoveryFailed).not.toHaveBeenCalled();
    watchdog.stop();
  });

  test('fires onStreamRecoveryFailed with consecutiveFailCount on recovery failure', async () => {
    const client = createMockClient();
    client.fetchKlines.mockRejectedValue(new Error('REST 500'));

    const onStreamRecoveryFailed = jest.fn();

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, onStreamRecoveryFailed },
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());
    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(onStreamRecoveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', interval: '5m', consecutiveFailCount: 1 })
    );
    watchdog.stop();
  });

  test('success-only notify lists each recovered symbol grouped by interval', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();

    client.fetchKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'BTCUSDT') {
        return [buildKline(T0), buildKline(T0 + FIVE_MIN_MS), buildKline(T0 + 2 * FIVE_MIN_MS, false)];
      }

      return [buildKline(T0), buildKline(T0 + FIVE_MIN_MS)];
    });

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 5, restRefetchLimit: 100 },
      onNotify,
    });

    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(onNotify).toHaveBeenCalledTimes(2);
    const overdueMessage = onNotify.mock.calls[0][0] as string;
    expect(overdueMessage).toContain('subscriptions overdue');
    expect(overdueMessage).toContain('2 total');

    const recoveryMessage = onNotify.mock.calls[1][0] as string;
    expect(recoveryMessage).toContain('✅ Bybit Futures — Kline recovery complete (2 symbols, 5m: 2)');
    expect(recoveryMessage).toContain('5m (2 symbols)');
    expect(recoveryMessage).toContain('BTCUSDT, ETHUSDT');
    expect(recoveryMessage).not.toContain('klines refetched');
    expect(recoveryMessage).not.toContain('• 5m:');

    watchdog.stop();
  });

  test('WS-events for key are suppressed during recovery and resume after', async () => {
    const client = createMockClient();
    let resolveFetch: (klineList: Kline[]) => void = () => undefined;
    client.fetchKlines.mockImplementation(() => new Promise<Kline[]>((resolve) => {
      resolveFetch = resolve;
    }));

    const userHandler = jest.fn();
    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, restRefetchLimit: 100 },
    });

    const wrapped = watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(client.resubscribeKlines).toHaveBeenCalledTimes(1);

    const intermediateKline = buildKline(T0 + FIVE_MIN_MS);
    wrapped('BTCUSDT', intermediateKline);

    expect(userHandler).not.toHaveBeenCalled();

    resolveFetch([buildKline(T0 + 2 * FIVE_MIN_MS)]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const lateKline = buildKline(T0 + 3 * FIVE_MIN_MS);
    wrapped('BTCUSDT', lateKline);
    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', lateKline);

    watchdog.stop();
  });

  test('recovery cooldown after fail suppresses retries until cooldown elapses', async () => {
    const client = createMockClient();
    client.fetchKlines.mockRejectedValue(new Error('REST 500'));

    const userHandler = jest.fn();
    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: {
        checkIntervalMs: 30_000,
        graceMs: 1_000,
        restRefetchLimit: 100,
        recoveryCooldownMs: 120_000,
        recoveryFailCountThreshold: 100,
        restInterCallMs: 0,
      },
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(2);

    watchdog.stop();
  });

  test('fail-cooldown extends to recoveryFailCooldownMs after consecutiveFailCount threshold', async () => {
    const client = createMockClient();
    client.fetchKlines.mockRejectedValue(new Error('REST 500'));

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: {
        checkIntervalMs: 30_000,
        graceMs: 1_000,
        restRefetchLimit: 100,
        recoveryCooldownMs: 60_000,
        recoveryFailCooldownMs: 300_000,
        recoveryFailCountThreshold: 2,
        restInterCallMs: 0,
      },
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(90_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(90_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(240_000);
    expect(client.fetchKlines).toHaveBeenCalledTimes(3);

    watchdog.stop();
  });

  test('parallelism limit caps concurrent recoveries', async () => {
    const client = createMockClient();
    let activeCount = 0;
    let observedPeak = 0;

    client.fetchKlines.mockImplementation(async () => {
      activeCount += 1;
      observedPeak = Math.max(observedPeak, activeCount);
      await Promise.resolve();
      await Promise.resolve();
      activeCount -= 1;
      return [buildKline(T0)];
    });

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 3, restRefetchLimit: 100, restInterCallMs: 0 },
    });

    const symbolList = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'];

    for (const symbol of symbolList) {
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(observedPeak).toBeGreaterThan(0);
    expect(observedPeak).toBeLessThanOrEqual(3);
    expect(client.fetchKlines.mock.calls.length).toBe(symbolList.length);

    watchdog.stop();
  });

  test('unregisterHandler clears state for key', () => {
    const client = createMockClient();
    const watchdog = new KlineSubscriptionWatchdog({ client, clientLabel: 'test' });

    const wrapped = watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());
    wrapped('BTCUSDT', buildKline(T0));

    expect(watchdog.getDiagnosticInfo().totalSubscriptions).toBe(1);

    watchdog.unregisterHandler('BTCUSDT', '5m' as KlineInterval);

    expect(watchdog.getDiagnosticInfo().totalSubscriptions).toBe(0);
  });

  test('aggregates partial-failure recovery into a single multi-line notify', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();

    client.fetchKlines.mockImplementation(async (symbol: string) => {
      if (symbol === 'XRPUSDT') {
        throw new Error('REST 503');
      }

      return [buildKline(T0)];
    });

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 5, restRefetchLimit: 100 },
      onNotify,
    });

    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']) {
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(onNotify).toHaveBeenCalledTimes(2);
    const overdueMessage = onNotify.mock.calls[0][0] as string;
    expect(overdueMessage).toContain('subscriptions overdue');
    expect(overdueMessage).toContain('3 total');

    const recoveryMessage = onNotify.mock.calls[1][0] as string;
    expect(recoveryMessage).toContain('🔄 Bybit Futures — Kline recovery');
    expect(recoveryMessage).toContain('5m: 3');
    expect(recoveryMessage).toContain('✅ Recovered: 2');
    expect(recoveryMessage).toContain('❌ Failed: 1');
    expect(recoveryMessage).toContain('XRPUSDT');
    expect(recoveryMessage).toContain('REST: REST 503');

    watchdog.stop();
  });

  test('after successful recovery with fresh klines symbol is no longer overdue', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, restRefetchLimit: 100 },
      onNotify,
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());

    client.fetchKlines.mockResolvedValue([buildKline(T0 + 2 * FIVE_MIN_MS)]);
    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(onNotify).toHaveBeenCalledTimes(2);

    onNotify.mockClear();

    await jest.advanceTimersByTimeAsync(120_000);
    expect(onNotify).not.toHaveBeenCalled();

    watchdog.stop();
  });

  test('overdue groups symbols by lag bucket within interval', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();
    client.fetchKlines.mockResolvedValue([buildKline(T0)]);

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 5, restRefetchLimit: 100 },
      onNotify,
    });

    watchdog.wrapHandler('AAA', '5m' as KlineInterval, jest.fn());
    watchdog.wrapHandler('BBB', '5m' as KlineInterval, jest.fn());
    watchdog.wrapHandler('CCC', '5m' as KlineInterval, jest.fn());

    const wrappedC = watchdog.wrapHandler.bind(watchdog);
    void wrappedC;

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    const overdueMessage = onNotify.mock.calls[0][0] as string;
    expect(overdueMessage).toContain('Kline subscriptions overdue (3 total)');
    expect(overdueMessage).toMatch(/5m — Lag \d+s \(3 symbols\)/);
    const lagBlockMatchList = overdueMessage.match(/5m — Lag \d+s/g);
    expect(lagBlockMatchList).not.toBeNull();
    expect(lagBlockMatchList!.length).toBe(1);

    watchdog.stop();
  });

  test('overdue separates symbols with chasers from those without via symbolMarker', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();
    client.fetchKlines.mockResolvedValue([buildKline(T0)]);

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: {
        checkIntervalMs: 30_000,
        graceMs: 1_000,
        parallelismLimit: 5,
        restRefetchLimit: 100,
        symbolMarker: (symbol: string): string => {
          if (symbol === 'BTCUSDT') return '📦 ';
          if (symbol === 'ETHUSDT') return '✨ ';
          return '';
        },
      },
      onNotify,
    });

    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'AAAUSDT', 'ZZZUSDT']) {
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    const overdueMessage = onNotify.mock.calls[0][0] as string;

    expect(overdueMessage).toContain('📦 BTCUSDT');
    expect(overdueMessage).toContain('✨ ETHUSDT');

    const lines = overdueMessage.split('\n');
    const lagHeaderIndex = lines.findIndex((line) => /5m — Lag \d+s \(4 symbols\)/.test(line));
    expect(lagHeaderIndex).toBeGreaterThanOrEqual(0);

    const withChaserLine = lines[lagHeaderIndex + 1];
    const noChaserLine = lines[lagHeaderIndex + 2];

    expect(withChaserLine).toBe('📦 BTCUSDT, ✨ ETHUSDT');
    expect(noChaserLine).toBe('AAAUSDT, ZZZUSDT');

    watchdog.stop();
  });

  test('overdue omits with-chaser line when no symbols carry a marker', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();
    client.fetchKlines.mockResolvedValue([buildKline(T0)]);

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: {
        checkIntervalMs: 30_000,
        graceMs: 1_000,
        parallelismLimit: 5,
        restRefetchLimit: 100,
        symbolMarker: (): string => '',
      },
      onNotify,
    });

    for (const symbol of ['AAAUSDT', 'BBBUSDT']) {
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    const overdueMessage = onNotify.mock.calls[0][0] as string;
    const lines = overdueMessage.split('\n');
    const lagHeaderIndex = lines.findIndex((line) => /5m — Lag \d+s \(2 symbols\)/.test(line));

    expect(lagHeaderIndex).toBeGreaterThanOrEqual(0);
    expect(lines[lagHeaderIndex + 1]).toBe('AAAUSDT, BBBUSDT');

    watchdog.stop();
  });

  test('overdue splits message into multiple onNotify calls when over Telegram limit', async () => {
    const client = createMockClient();
    const onNotify = jest.fn();
    client.fetchKlines.mockResolvedValue([buildKline(T0)]);

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'Bybit Futures',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, parallelismLimit: 50, restRefetchLimit: 100, restInterCallMs: 0 },
      onNotify,
    });

    const symbolList: string[] = [];

    for (let i = 0; i < 600; i += 1) {
      const symbol = `SYM${i.toString().padStart(4, '0')}USDT`;
      symbolList.push(symbol);
      watchdog.wrapHandler(symbol, '5m' as KlineInterval, jest.fn());
    }

    jest.setSystemTime(T0 + 2 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    const recoveryStartIndex = onNotify.mock.calls.findIndex((call) => (call[0] as string).startsWith('✅'));
    expect(recoveryStartIndex).toBeGreaterThan(0);

    const overdueCallList = onNotify.mock.calls.slice(0, recoveryStartIndex);
    expect(overdueCallList.length).toBeGreaterThan(1);

    for (const call of overdueCallList) {
      expect((call[0] as string).length).toBeLessThanOrEqual(4096);
    }

    expect((overdueCallList[0][0] as string).startsWith('⚠️')).toBe(true);

    const combined = overdueCallList.map((call) => call[0] as string).join('\n');
    for (const symbol of symbolList) {
      expect(combined).toContain(symbol);
    }

    watchdog.stop();
  });

  test('fresh-only replay skips klines older than lastKnownOpenTimestamp', async () => {
    const client = createMockClient();
    const userHandler = jest.fn();

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 1_000, restRefetchLimit: 100, restInterCallMs: 0 },
    });

    const wrapped = watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, userHandler);

    wrapped('BTCUSDT', buildKline(T0 + 5 * FIVE_MIN_MS));
    userHandler.mockClear();

    const replayKlineList = [
      buildKline(T0 + FIVE_MIN_MS),
      buildKline(T0 + 2 * FIVE_MIN_MS),
      buildKline(T0 + 5 * FIVE_MIN_MS),
      buildKline(T0 + 6 * FIVE_MIN_MS),
      buildKline(T0 + 7 * FIVE_MIN_MS),
    ];
    client.fetchKlines.mockResolvedValue(replayKlineList);

    jest.setSystemTime(T0 + 10 * FIVE_MIN_MS);
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(userHandler).toHaveBeenCalledTimes(2);
    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', replayKlineList[3]);
    expect(userHandler).toHaveBeenCalledWith('BTCUSDT', replayKlineList[4]);

    watchdog.stop();
  });

  test('initial set in wrapHandler prevents false-positive overdue before first kline', async () => {
    const client = createMockClient();
    client.fetchKlines.mockResolvedValue([buildKline(T0)]);

    const watchdog = new KlineSubscriptionWatchdog({
      client,
      clientLabel: 'test',
      config: { checkIntervalMs: 30_000, graceMs: 10_000, restRefetchLimit: 100 },
    });

    watchdog.wrapHandler('BTCUSDT', '5m' as KlineInterval, jest.fn());
    watchdog.start();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(client.resubscribeKlines).not.toHaveBeenCalled();
    expect(client.fetchKlines).not.toHaveBeenCalled();

    watchdog.stop();
  });
});
