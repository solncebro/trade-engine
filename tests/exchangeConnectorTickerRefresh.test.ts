import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';
import type { Ticker } from '@solncebro/exchange-engine';

import { logger } from '../src/core/logger';
import { ExchangeConnector } from '../src/services/exchangeConnector';
import type { TickerPollingConfig } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

interface FakeClient {
  tradeSymbols: Map<string, unknown>;
  loadTradeSymbols: jest.Mock;
  fetchTickers: jest.Mock;
  fetchTicker: jest.Mock;
  fetchAllLeverageTierList: jest.Mock;
  fetchLeverageTierList: jest.Mock;
  getOrderRateLimit: jest.Mock;
  amountToPrecision: (symbol: string, amount: number) => number;
  priceToPrecision: (symbol: string, price: number) => number;
}

// mock-prefixed so the jest.mock factory may reference it: every `new Exchange()` gets fresh clients.
const mockCreatedClientList: Array<{ futures: FakeClient; spot: FakeClient }> = [];

function mockBuildClient(): FakeClient {
  const tradeSymbols = new Map<string, unknown>();

  return {
    tradeSymbols,
    loadTradeSymbols: jest.fn(async () => tradeSymbols),
    fetchTickers: jest.fn(async () => new Map()),
    fetchTicker: jest.fn(),
    fetchAllLeverageTierList: jest.fn(async () => new Map()),
    fetchLeverageTierList: jest.fn(async () => []),
    getOrderRateLimit: jest.fn(async () => ({ writeRequestsPerSecond: 10, source: 'test' })),
    amountToPrecision: (_symbol: string, amount: number) => amount,
    priceToPrecision: (_symbol: string, price: number) => price,
  };
}

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => {
      const clients = { futures: mockBuildClient(), spot: mockBuildClient() };

      mockCreatedClientList.push(clients);

      return { ...clients, close: jest.fn() };
    }),
  };
});

function buildTicker(symbol: string, lastPrice: number): Ticker {
  return { symbol, lastPrice } as unknown as Ticker;
}

function buildConnector(tickerPollingConfig?: TickerPollingConfig): { connector: ExchangeConnector; futures: FakeClient; spot: FakeClient } {
  const connector = new ExchangeConnector(
    ExchangeNameEnum.Binance,
    { apiKey: 'k', secret: 's' } as ExchangeConfig,
    undefined,
    PositionModeEnum.OneWay,
    { isEnabled: false },
    null,
    undefined,
    { tradeSymbolsRefreshIntervalMs: 0 },
    tickerPollingConfig
  );
  const clients = mockCreatedClientList[mockCreatedClientList.length - 1];

  return { connector, ...clients };
}

describe('ExchangeConnector ticker polling config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('polls futures and spot by default', async () => {
    const { connector, futures, spot } = buildConnector();

    await connector.initialize();
    await connector.waitForTickersReady(50);

    expect(futures.fetchTickers).toHaveBeenCalledTimes(1);
    expect(spot.fetchTickers).toHaveBeenCalledTimes(1);

    await connector.disconnect();
  });

  it('isEnabled false: no bulk request at all and waitForTickersReady returns at once', async () => {
    const { connector, futures, spot } = buildConnector({ isEnabled: false });

    await connector.initialize();

    await expect(connector.waitForTickersReady(30_000)).resolves.toBe(false);
    expect(futures.fetchTickers).not.toHaveBeenCalled();
    expect(spot.fetchTickers).not.toHaveBeenCalled();
  });

  it('marketTypeList [Futures]: spot is not requested', async () => {
    const { connector, futures, spot } = buildConnector({ marketTypeList: [MarketTypeEnum.Futures] });

    await connector.initialize();
    await expect(connector.waitForTickersReady(1_000, MarketTypeEnum.Futures)).resolves.toBe(false);

    expect(futures.fetchTickers).toHaveBeenCalledTimes(1);
    expect(spot.fetchTickers).not.toHaveBeenCalled();

    await connector.disconnect();
  });
});

describe('ExchangeConnector.refreshTicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-11-17T00:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes the single ticker into the cache that getTicker reads', async () => {
    const { connector, futures } = buildConnector({ isEnabled: false });
    futures.fetchTicker.mockResolvedValue(buildTicker('BTCUSDT', 100));

    const ticker = await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    expect(ticker?.lastPrice).toBe(100);
    expect(connector.getTicker('BTCUSDT', MarketTypeEnum.Futures)?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledWith('BTCUSDT');
  });

  it('a repeat inside 5 s is served from the cache, after 5 s it asks the exchange again', async () => {
    const { connector, futures } = buildConnector({ isEnabled: false });
    futures.fetchTicker.mockResolvedValueOnce(buildTicker('BTCUSDT', 100)).mockResolvedValueOnce(buildTicker('BTCUSDT', 101));

    await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    jest.setSystemTime(Date.now() + 4_999);
    const cached = await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    expect(cached?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 2);
    const fresh = await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    expect(fresh?.lastPrice).toBe(101);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(2);
  });

  it('two concurrent calls for one symbol share one request', async () => {
    const { connector, futures } = buildConnector({ isEnabled: false });
    let resolveTicker: (ticker: Ticker) => void = () => undefined;
    futures.fetchTicker.mockReturnValue(new Promise<Ticker>(resolve => { resolveTicker = resolve; }));

    const first = connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    const second = connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    resolveTicker(buildTicker('BTCUSDT', 100));

    expect((await first)?.lastPrice).toBe(100);
    expect((await second)?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(1);
  });

  it('a follower hands the call to its primary', async () => {
    const primary = buildConnector({ isEnabled: false });
    const follower = buildConnector({ isEnabled: false });
    follower.connector.shareMarketDataFrom(primary.connector);
    primary.futures.fetchTicker.mockResolvedValue(buildTicker('BTCUSDT', 100));

    const ticker = await follower.connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    expect(ticker?.lastPrice).toBe(100);
    expect(primary.futures.fetchTicker).toHaveBeenCalledTimes(1);
    expect(follower.futures.fetchTicker).not.toHaveBeenCalled();
    expect(follower.connector.getTicker('BTCUSDT', MarketTypeEnum.Futures)?.lastPrice).toBe(100);
  });

  it('a failed read warns with the error text and returns the cache (null when empty), never throws', async () => {
    const { connector, futures, spot } = buildConnector({ isEnabled: false });
    spot.fetchTicker.mockRejectedValue(new Error('Single ticker is not supported'));

    await expect(connector.refreshTicker('BTCUSDT', MarketTypeEnum.Spot)).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorText: expect.stringContaining('Single ticker is not supported') }),
      expect.any(String)
    );

    futures.fetchTicker.mockResolvedValueOnce(buildTicker('BTCUSDT', 100));
    await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    jest.setSystemTime(Date.now() + 6_000);
    futures.fetchTicker.mockRejectedValue(new Error('exchange is down'));

    const stale = await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    expect(stale?.lastPrice).toBe(100);
  });

  it('shouldServeCacheOnFailure false: a failed read gives null while the bulk poll holds a price, the plain call still serves it', async () => {
    const { connector, futures } = buildConnector({ marketTypeList: [MarketTypeEnum.Futures] });
    futures.fetchTickers.mockResolvedValue(new Map([['BTCUSDT', buildTicker('BTCUSDT', 100)]]));

    await connector.initialize();
    await expect(connector.waitForTickersReady(1_000, MarketTypeEnum.Futures)).resolves.toBe(true);
    jest.setSystemTime(Date.now() + 6_000);
    futures.fetchTicker.mockRejectedValue(new Error('exchange is down'));

    await expect(connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures, { shouldServeCacheOnFailure: false })).resolves.toBeNull();
    expect((await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures))?.lastPrice).toBe(100);
    expect(connector.getTicker('BTCUSDT', MarketTypeEnum.Futures)?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(2);

    await connector.disconnect();
  });

  it('a strict and a plain call sharing one failed request: the strict one gets null, the plain one the cache', async () => {
    const { connector, futures } = buildConnector({ isEnabled: false });
    futures.fetchTicker.mockResolvedValueOnce(buildTicker('BTCUSDT', 100));
    await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    jest.setSystemTime(Date.now() + 6_000);
    let rejectTicker: (error: Error) => void = () => undefined;
    futures.fetchTicker.mockReturnValue(new Promise<Ticker>((_resolve, reject) => { rejectTicker = reject; }));

    const strict = connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures, { shouldServeCacheOnFailure: false });
    const plain = connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);

    rejectTicker(new Error('exchange is down'));

    await expect(strict).resolves.toBeNull();
    expect((await plain)?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(2);
  });

  it('a strict read inside 5 s of a successful one is served from the cache', async () => {
    const { connector, futures } = buildConnector({ isEnabled: false });
    futures.fetchTicker.mockResolvedValueOnce(buildTicker('BTCUSDT', 100));

    await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    jest.setSystemTime(Date.now() + 4_999);

    expect((await connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures, { shouldServeCacheOnFailure: false }))?.lastPrice).toBe(100);
    expect(futures.fetchTicker).toHaveBeenCalledTimes(1);
  });

  it('a follower hands the strict read to its primary', async () => {
    const primary = buildConnector({ isEnabled: false });
    const follower = buildConnector({ isEnabled: false });
    follower.connector.shareMarketDataFrom(primary.connector);
    primary.futures.fetchTicker.mockResolvedValueOnce(buildTicker('BTCUSDT', 100));
    await follower.connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures);
    jest.setSystemTime(Date.now() + 6_000);
    primary.futures.fetchTicker.mockRejectedValue(new Error('exchange is down'));

    await expect(follower.connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures, { shouldServeCacheOnFailure: false })).resolves.toBeNull();
    expect((await follower.connector.refreshTicker('BTCUSDT', MarketTypeEnum.Futures))?.lastPrice).toBe(100);
  });
});
