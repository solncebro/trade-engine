import { EventEmitter } from 'events';

import { buildKlineList, KLINE_INTERVAL_MS } from './trendTestKlines';

import type { MarketDataSource } from '../src/core/marketDataSource.types';
import type { TrendCalculatorConfig } from '../src/core/trendCalculator.types';
import { TrendMonitor } from '../src/core/TrendMonitor';
import type { TrendChangedEvent } from '../src/core/TrendMonitor.types';
import type { Kline, KlineInterval, MaValues } from '../src/types/index';

const CONFIG: TrendCalculatorConfig = {
  reversalAtrMultiplier: 0,
  minReversalPercent: 2,
};

const UP_CLOSE_LIST = [100, 104, 100, 105, 101, 106, 102, 104];
const ALTERNATE_UP_CLOSE_LIST = [100, 104, 100, 105, 101, 106, 102, 105];
const DOWN_CLOSE_LIST = [100, 96, 99, 94, 98, 93, 97, 92];
const INSUFFICIENT_CLOSE_LIST = [100, 100.5, 100, 100.5];

const SYMBOL = 'AAAUSDT';

class FakeMarketDataSource extends EventEmitter implements MarketDataSource {
  public throwOnGetKlineList = false;
  private readonly klineListBySymbol = new Map<string, Kline[]>();

  constructor(private readonly interval: KlineInterval) {
    super();
  }

  setKlineList(symbol: string, klineList: Kline[]): void {
    this.klineListBySymbol.set(symbol, klineList);
  }

  dropSymbol(symbol: string): void {
    this.klineListBySymbol.delete(symbol);
  }

  getInterval(): KlineInterval {
    return this.interval;
  }

  getIntervalMs(): number {
    return KLINE_INTERVAL_MS;
  }

  getMaValues(): MaValues {
    return { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };
  }

  getKlineList(symbol: string): Kline[] {
    if (this.throwOnGetKlineList) {
      throw new Error('market data source failure');
    }

    return this.klineListBySymbol.get(symbol) ?? [];
  }

  getCurrentKline(symbol: string): Kline | undefined {
    return this.klineListBySymbol.get(symbol)?.at(-1);
  }

  getSymbolList(): string[] {
    return [...this.klineListBySymbol.keys()];
  }

  getLastKlineOpenTimestamp(symbol: string): number | undefined {
    return this.getCurrentKline(symbol)?.openTimestamp;
  }

  getLastUpdateTimestamp(): number | undefined {
    return undefined;
  }

  getStaleSymbolList(): { symbol: string; ageMs: number }[] {
    return [];
  }

  async shutdown(): Promise<void> {}
}

function collectTrendChangedEvents(monitor: TrendMonitor): TrendChangedEvent[] {
  const eventList: TrendChangedEvent[] = [];

  monitor.on('trendChanged', event => eventList.push(event));

  return eventList;
}

function appendFormingCandle(klineList: Kline[], closePrice: number): Kline[] {
  const index = klineList.length;
  const openTimestamp = index * KLINE_INTERVAL_MS;

  return [
    ...klineList,
    {
      openTimestamp,
      openPrice: closePrice,
      highPrice: closePrice,
      lowPrice: closePrice,
      closePrice,
      volume: 0,
      closeTimestamp: openTimestamp + KLINE_INTERVAL_MS - 1,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      isClosed: false,
    },
  ];
}

function buildMonitor(
  entryList: [KlineInterval, FakeMarketDataSource][]
): TrendMonitor {
  const marketDataManagerByInterval = new Map<KlineInterval, MarketDataSource>(
    entryList
  );

  return new TrendMonitor({ marketDataManagerByInterval, config: CONFIG });
}

describe('TrendMonitor', () => {
  test('does not emit trendChanged during the initial pass and caches the assessment', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();

    const result = monitor.getTrend(SYMBOL, '30m');

    expect(eventList).toHaveLength(0);
    expect(result?.kind).toBe('assessed');

    if (result?.kind === 'assessed') {
      expect(result.assessment.direction).toBe('up');
    }

    monitor.stop();
  });

  test('emits a single trendChanged when the direction flips on a closed candle', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(SYMBOL, buildKlineList(DOWN_CLOSE_LIST));
    source.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(1);
    expect(eventList[0].symbol).toBe(SYMBOL);
    expect(eventList[0].interval).toBe('30m');
    expect(eventList[0].previousDirection).toBe('up');
    expect(eventList[0].currentDirection).toBe('down');
    expect(eventList[0].result.kind).toBe('assessed');

    monitor.stop();
  });

  test('does not emit when the recomputed direction is unchanged', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(SYMBOL, buildKlineList(ALTERNATE_UP_CLOSE_LIST));
    source.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(0);

    monitor.stop();
  });

  test('does not emit when transitioning out of insufficient_data into an assessment', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(INSUFFICIENT_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    source.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(0);
    expect(monitor.getTrend(SYMBOL, '30m')?.kind).toBe('assessed');

    monitor.stop();
  });

  test('computes a newly added symbol without emitting a change event', () => {
    const source = new FakeMarketDataSource('30m');

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    source.emit('symbolAdded', SYMBOL);

    expect(eventList).toHaveLength(0);
    expect(monitor.getTrend(SYMBOL, '30m')?.kind).toBe('assessed');

    monitor.stop();
  });

  test('drops a symbol from the cache on symbolRemoved', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);

    monitor.start();
    source.emit('symbolRemoved', SYMBOL);

    expect(monitor.getTrend(SYMBOL, '30m')).toBeUndefined();

    monitor.stop();
  });

  test('detaches all listeners and stops recomputing on stop', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    monitor.stop();

    expect(source.listenerCount('klineClosed')).toBe(0);
    expect(source.listenerCount('symbolAdded')).toBe(0);
    expect(source.listenerCount('symbolRemoved')).toBe(0);

    source.setKlineList(SYMBOL, buildKlineList(DOWN_CLOSE_LIST));
    source.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(0);
    expect(monitor.getTrend(SYMBOL, '30m')).toBeUndefined();
  });

  test('summarises a single aligned direction across intervals', () => {
    const source30m = new FakeMarketDataSource('30m');
    const source4h = new FakeMarketDataSource('4h');
    source30m.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    source4h.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([
      ['30m', source30m],
      ['4h', source4h],
    ]);

    monitor.start();

    const summary = monitor.getTrendSummary(SYMBOL);

    expect(summary.alignedDirection).toBe('up');
    expect(summary.byInterval.get('30m')?.kind).toBe('assessed');
    expect(summary.byInterval.get('4h')?.kind).toBe('assessed');

    monitor.stop();
  });

  test('returns a null aligned direction when intervals disagree', () => {
    const source30m = new FakeMarketDataSource('30m');
    const source4h = new FakeMarketDataSource('4h');
    source30m.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    source4h.setKlineList(SYMBOL, buildKlineList(DOWN_CLOSE_LIST));

    const monitor = buildMonitor([
      ['30m', source30m],
      ['4h', source4h],
    ]);

    monitor.start();

    expect(monitor.getTrendSummary(SYMBOL).alignedDirection).toBeNull();

    monitor.stop();
  });

  test('returns a null aligned direction when any interval lacks an assessment', () => {
    const source30m = new FakeMarketDataSource('30m');
    const source4h = new FakeMarketDataSource('4h');
    source30m.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    source4h.setKlineList(SYMBOL, buildKlineList(INSUFFICIENT_CLOSE_LIST));

    const monitor = buildMonitor([
      ['30m', source30m],
      ['4h', source4h],
    ]);

    monitor.start();

    const summary = monitor.getTrendSummary(SYMBOL);

    expect(summary.alignedDirection).toBeNull();
    expect(summary.byInterval.get('4h')?.kind).toBe('insufficient_data');

    monitor.stop();
  });

  test('includes a late-attached interval in the summary', () => {
    const source30m = new FakeMarketDataSource('30m');
    source30m.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source30m]]);

    monitor.start();

    const source4h = new FakeMarketDataSource('4h');
    source4h.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    monitor.attachMarketDataManager('4h', source4h);

    const summary = monitor.getTrendSummary(SYMBOL);

    expect(summary.byInterval.get('4h')?.kind).toBe('assessed');
    expect(summary.alignedDirection).toBe('up');

    monitor.stop();
  });

  test('recomputes and emits for a late-attached interval on its own closed candle', () => {
    const source30m = new FakeMarketDataSource('30m');
    source30m.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source30m]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();

    const source4h = new FakeMarketDataSource('4h');
    source4h.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));
    monitor.attachMarketDataManager('4h', source4h);

    source4h.setKlineList(SYMBOL, buildKlineList(DOWN_CLOSE_LIST));
    source4h.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(1);
    expect(eventList[0].interval).toBe('4h');
    expect(eventList[0].currentDirection).toBe('down');

    monitor.stop();
  });

  test('does not emit when an assessment degrades into insufficient_data', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(SYMBOL, buildKlineList(INSUFFICIENT_CLOSE_LIST));
    source.emit('klineClosed', SYMBOL);

    expect(eventList).toHaveLength(0);
    expect(monitor.getTrend(SYMBOL, '30m')?.kind).toBe('insufficient_data');

    monitor.stop();
  });

  test('ignores a trailing forming candle when assessing on a closed-candle event', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.setKlineList(
      SYMBOL,
      appendFormingCandle(buildKlineList(UP_CLOSE_LIST), 90)
    );
    source.emit('klineClosed', SYMBOL);

    const result = monitor.getTrend(SYMBOL, '30m');

    expect(eventList).toHaveLength(0);
    expect(result?.kind).toBe('assessed');

    if (result?.kind === 'assessed') {
      expect(result.assessment.direction).toBe('up');
    }

    monitor.stop();
  });

  test('does not throw or emit when the market data source fails to provide klines', () => {
    const source = new FakeMarketDataSource('30m');
    source.setKlineList(SYMBOL, buildKlineList(UP_CLOSE_LIST));

    const monitor = buildMonitor([['30m', source]]);
    const eventList = collectTrendChangedEvents(monitor);

    monitor.start();
    source.throwOnGetKlineList = true;

    expect(() => source.emit('klineClosed', SYMBOL)).not.toThrow();
    expect(eventList).toHaveLength(0);

    monitor.stop();
  });
});
