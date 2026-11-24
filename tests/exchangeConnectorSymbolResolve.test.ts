import { ExchangeNameEnum, PositionModeEnum } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum } from '../src/types';

jest.mock('../src/core/logger', () => ({
  logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));

interface FakeClient {
  tradeSymbols: Map<string, unknown>;
  loadTradeSymbols: jest.Mock;
  fetchTickers: jest.Mock;
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

const TICKER = { symbol: 'X', lastPrice: 1 };

function buildConnector(config: Partial<ExchangeConfig> = {}, tickerPollingConfig?: { isEnabled?: boolean }): { connector: ExchangeConnector; futures: FakeClient; spot: FakeClient } {
  const connector = new ExchangeConnector(
    ExchangeNameEnum.Binance,
    { apiKey: 'k', secret: 's', ...config } as ExchangeConfig,
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

function listTickers(symbolList: string[]): Map<string, unknown> {
  return new Map(symbolList.map(symbol => [symbol, { ...TICKER, symbol }]));
}

describe('ExchangeConnector symbol resolution', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('findSymbolWithPrefix reports a miss as null; resolveSymbolWithPrefix still hands the input back', async () => {
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockResolvedValue(listTickers(['1000PEPEUSDT', 'BTCUSDT']));
    await connector.initialize();
    await connector.waitForTickersReady(1000);

    expect(connector.findSymbolWithPrefix('PEPEUSDT', MarketTypeEnum.Futures)).toBe('1000PEPEUSDT');
    expect(connector.findSymbolWithPrefix('BTCUSDT', MarketTypeEnum.Futures)).toBe('BTCUSDT');
    expect(connector.findSymbolWithPrefix('NOPEUSDT', MarketTypeEnum.Futures)).toBeNull();
    expect(connector.resolveSymbolWithPrefix('NOPEUSDT', MarketTypeEnum.Futures)).toBe('NOPEUSDT');
    await connector.disconnect();
  });

  it('resolveFuturesSymbol: "$pepe" → 1000PEPEUSDT (prefix by tickers), found when the spec is loaded', async () => {
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockResolvedValue(listTickers(['1000PEPEUSDT', 'BTCUSDT']));
    futures.tradeSymbols.set('1000PEPEUSDT', {});
    futures.tradeSymbols.set('BTCUSDT', {});
    await connector.initialize();

    expect(await connector.resolveFuturesSymbol('$pepe')).toEqual({ symbol: '1000PEPEUSDT', isFound: true });
    expect(await connector.resolveFuturesSymbol('BTC/USDT:USDT')).toEqual({ symbol: 'BTCUSDT', isFound: true });
    await connector.disconnect();
  });

  it('resolveFuturesSymbol: a multiplier written after the base (Bybit SHIB1000USDT) is found too', async () => {
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockResolvedValue(listTickers(['SHIB1000USDT']));
    futures.tradeSymbols.set('SHIB1000USDT', {});
    await connector.initialize();

    expect(await connector.resolveFuturesSymbol('shib')).toEqual({ symbol: 'SHIB1000USDT', isFound: true });
    // The old door is unchanged: it never looked for a suffix.
    expect(connector.resolveSymbolWithPrefix('SHIBUSDT', MarketTypeEnum.Futures)).toBe('SHIBUSDT');
    await connector.disconnect();
  });

  it('resolveFuturesSymbol: an unknown coin is not found (one on-demand reload, then the cooldown)', async () => {
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockResolvedValue(listTickers(['BTCUSDT']));
    futures.tradeSymbols.set('BTCUSDT', {});
    await connector.initialize();
    futures.loadTradeSymbols.mockClear();

    expect(await connector.resolveFuturesSymbol('#nope')).toEqual({ symbol: 'NOPEUSDT', isFound: false });
    expect(futures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(await connector.resolveFuturesSymbol('   ')).toEqual({ symbol: '', isFound: false });
    await connector.disconnect();
  });

  it('resolveFuturesSymbol: a coin listed after start (no ticker yet) is found through the spec reload', async () => {
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockResolvedValue(listTickers(['BTCUSDT']));
    futures.tradeSymbols.set('BTCUSDT', {});
    await connector.initialize();
    futures.loadTradeSymbols.mockImplementation(async () => {
      futures.tradeSymbols.set('NEWUSDT', {});

      return futures.tradeSymbols;
    });

    expect(await connector.resolveFuturesSymbol('new')).toEqual({ symbol: 'NEWUSDT', isFound: true });
    await connector.disconnect();
  });

  it('resolveFuturesSymbol: poll off, ticker cache empty — found by the instruments list in the same candidate order', async () => {
    const { connector, futures } = buildConnector({}, { isEnabled: false });
    futures.tradeSymbols.set('1000PEPEUSDT', {});
    futures.tradeSymbols.set('SHIB1000USDT', {});
    futures.tradeSymbols.set('LINKUSDT', {});
    futures.tradeSymbols.set('100LINKUSDT', {});
    await connector.initialize();

    expect(futures.fetchTickers).not.toHaveBeenCalled();
    expect(await connector.resolveFuturesSymbol('PEPE')).toEqual({ symbol: '1000PEPEUSDT', isFound: true });
    expect(await connector.resolveFuturesSymbol('#shib')).toEqual({ symbol: 'SHIB1000USDT', isFound: true });
    expect(await connector.resolveFuturesSymbol('$link')).toEqual({ symbol: 'LINKUSDT', isFound: true });
    expect(await connector.resolveFuturesSymbol('nope')).toEqual({ symbol: 'NOPEUSDT', isFound: false });
    await connector.disconnect();
  });

  it('resolveSpotSymbol checks the spot list', async () => {
    const { connector, spot } = buildConnector();
    spot.fetchTickers.mockResolvedValue(listTickers(['ETHUSDT']));
    spot.tradeSymbols.set('ETHUSDT', {});
    await connector.initialize();

    expect(await connector.resolveSpotSymbol('eth')).toEqual({ symbol: 'ETHUSDT', isFound: true });
    await connector.disconnect();
  });
});

describe('ExchangeConnector.waitForTickersReady', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for the first ticker round that initialize() did not await', async () => {
    const { connector, futures } = buildConnector();
    let releaseTickers: (value: Map<string, unknown>) => void = () => undefined;
    futures.fetchTickers.mockReturnValue(new Promise(resolve => {
      releaseTickers = resolve;
    }));
    await connector.initialize();

    const readyPromise = connector.waitForTickersReady(5000);
    let isSettled = false;
    void readyPromise.then(() => {
      isSettled = true;
    });
    await Promise.resolve();
    expect(isSettled).toBe(false);

    releaseTickers(listTickers(['BTCUSDT']));
    expect(await readyPromise).toBe(true);
    await connector.disconnect();
  });

  it('answers false after the timeout when no snapshot came (failed read), never throws', async () => {
    jest.useFakeTimers();
    const { connector, futures } = buildConnector();
    futures.fetchTickers.mockRejectedValue(new Error('down'));
    await connector.initialize();

    const readyPromise = connector.waitForTickersReady(2000);
    await jest.advanceTimersByTimeAsync(2100);

    expect(await readyPromise).toBe(false);
    await connector.disconnect();
  });

  it('answers false without initialize()', async () => {
    jest.useFakeTimers();
    const { connector } = buildConnector();
    const readyPromise = connector.waitForTickersReady(1000);
    await jest.advanceTimersByTimeAsync(1100);

    expect(await readyPromise).toBe(false);
  });
});

describe('ExchangeConnector market-data sharing (master + sub-accounts)', () => {
  it('a follower loads nothing itself: specs copied, tickers and tiers read from the primary', async () => {
    const primary = buildConnector();
    primary.futures.tradeSymbols.set('BTCUSDT', { id: 'spec' });
    primary.spot.tradeSymbols.set('ETHUSDT', { id: 'spot-spec' });
    primary.futures.fetchTickers.mockResolvedValue(listTickers(['1000PEPEUSDT']));
    primary.futures.fetchAllLeverageTierList.mockResolvedValue(new Map([['BTCUSDT', [{ maxLeverage: 125 }]]]));
    await primary.connector.initialize();
    await primary.connector.waitForTickersReady(1000);

    const follower = buildConnector();
    follower.connector.shareMarketDataFrom(primary.connector);
    await follower.connector.initialize();

    expect(follower.connector.isMarketDataFollower()).toBe(true);
    expect(follower.futures.loadTradeSymbols).not.toHaveBeenCalled();
    expect(follower.futures.fetchTickers).not.toHaveBeenCalled();
    expect(follower.futures.fetchAllLeverageTierList).not.toHaveBeenCalled();
    expect(follower.futures.tradeSymbols.get('BTCUSDT')).toEqual({ id: 'spec' });
    expect(follower.spot.tradeSymbols.get('ETHUSDT')).toEqual({ id: 'spot-spec' });
    expect(follower.connector.findSymbolWithPrefix('PEPEUSDT', MarketTypeEnum.Futures)).toBe('1000PEPEUSDT');
    expect(follower.connector.getFuturesLeverageTierList('BTCUSDT')).toEqual([{ maxLeverage: 125 }]);
    expect(await follower.connector.waitForTickersReady(10)).toBe(true);

    await follower.connector.disconnect();
    await primary.connector.disconnect();
  });

  it('a fresh listing met by a follower is reloaded ONCE by the primary and reaches every follower', async () => {
    const primary = buildConnector();
    primary.futures.tradeSymbols.set('BTCUSDT', {});
    await primary.connector.initialize();
    const followerA = buildConnector();
    const followerB = buildConnector();
    followerA.connector.shareMarketDataFrom(primary.connector);
    followerB.connector.shareMarketDataFrom(primary.connector);
    await followerA.connector.initialize();
    await followerB.connector.initialize();
    primary.futures.loadTradeSymbols.mockClear();
    primary.futures.loadTradeSymbols.mockImplementation(async () => {
      primary.futures.tradeSymbols.set('NEWUSDT', { id: 'new' });

      return primary.futures.tradeSymbols;
    });

    expect(await followerA.connector.ensureFuturesTradeSymbolLoaded('NEWUSDT')).toBe(true);
    expect(primary.futures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(followerA.futures.loadTradeSymbols).not.toHaveBeenCalled();
    expect(followerB.futures.tradeSymbols.get('NEWUSDT')).toEqual({ id: 'new' });

    await followerA.connector.disconnect();
    await followerB.connector.disconnect();
    await primary.connector.disconnect();
  });

  it('refuses sharing across exchanges or demo/live, chains, and after initialize()', async () => {
    const primary = buildConnector();
    const demo = buildConnector({ isDemoMode: true });

    expect(() => demo.connector.shareMarketDataFrom(primary.connector)).toThrow('one exchange and one mode');
    expect(() => primary.connector.shareMarketDataFrom(primary.connector)).toThrow('itself');

    const follower = buildConnector();
    follower.connector.shareMarketDataFrom(primary.connector);
    const second = buildConnector();

    expect(() => second.connector.shareMarketDataFrom(follower.connector)).toThrow('root primary');
    expect(() => primary.connector.shareMarketDataFrom(buildConnector().connector)).toThrow('before initialize');

    const late = buildConnector();
    late.futures.tradeSymbols.set('BTCUSDT', {});
    await late.connector.initialize();

    expect(() => late.connector.shareMarketDataFrom(primary.connector)).toThrow('before initialize');
    await late.connector.disconnect();
  });

  it('a follower of a primary that was not initialized fails loudly', async () => {
    const primary = buildConnector();
    const follower = buildConnector();
    follower.connector.shareMarketDataFrom(primary.connector);

    await expect(follower.connector.initialize()).rejects.toThrow('initialize the primary first');
  });

  it('default behaviour is unchanged: without sharing each connector loads its own data', async () => {
    const first = buildConnector();
    const second = buildConnector();
    await first.connector.initialize();
    await second.connector.initialize();

    expect(first.futures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(second.futures.loadTradeSymbols).toHaveBeenCalledTimes(1);
    expect(second.connector.isMarketDataFollower()).toBe(false);
    await first.connector.disconnect();
    await second.connector.disconnect();
  });
});
