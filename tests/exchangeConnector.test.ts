import {
  ExchangeError,
  ExchangeNameEnum,
  PositionModeEnum,
  PositionSideEnum,
  TradeSymbolTypeEnum,
} from '@solncebro/exchange-engine';
import type { ExchangeClient, Kline, MarkPriceHandler, MarkPriceUpdate, TradeSymbol } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum, OrderSideEnum, OrderTypeEnum } from '../src/types';
import { sizeOrder, splitOrderQty } from '../src/utils/sizeOrder';

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

jest.mock('@solncebro/exchange-engine', () => {
  const actual = jest.requireActual('@solncebro/exchange-engine');

  return {
    ...actual,
    Exchange: jest.fn().mockImplementation(() => ({
      futures: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn(),
        createBatchOrders: jest.fn(),
        loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
        fetchTickers: jest.fn().mockResolvedValue(new Map()),
        getOrderRateLimit: jest.fn().mockResolvedValue({ writeRequestsPerSecond: 30, source: 'binance-exchange-info' }),
        tradeSymbols: new Map(),
        getMinOrderQty: jest.fn().mockReturnValue(0),
        getMinNotional: jest.fn().mockReturnValue(0),
        getMaxOrderQty: jest.fn().mockReturnValue(0),
        getMarketMaxOrderQty: jest.fn().mockReturnValue(0),
        fetchKlines: jest.fn().mockResolvedValue([]),
        isUserDataStreamConnected: jest.fn().mockReturnValue(true),
        getRateLimitState: jest.fn().mockReturnValue({ usedWeight: 120, weightLimit: 2400, observedAtMs: 1000, bannedUntilMs: null }),
      },
      spot: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn(),
        createBatchOrders: jest.fn(),
        loadTradeSymbols: jest.fn().mockResolvedValue(new Map()),
        fetchTickers: jest.fn().mockResolvedValue(new Map()),
        getOrderRateLimit: jest.fn().mockResolvedValue({ writeRequestsPerSecond: 30, source: 'binance-exchange-info' }),
        fetchKlines: jest.fn().mockResolvedValue([]),
        isUserDataStreamConnected: jest.fn().mockReturnValue(false),
        getRateLimitState: jest.fn().mockReturnValue({ usedWeight: null, weightLimit: null, observedAtMs: null, bannedUntilMs: null }),
      },
      close: jest.fn(),
    })),
  };
});

describe('ExchangeConnector.createOrder errorCode', () => {
  it('captures ExchangeError.code as errorCode in result', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.createOrderWebSocket as jest.Mock).mockRejectedValue(
      new ExchangeError('Bybit API error 110121: price limit', 110121, 'bybit'),
    );

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.errorCode).toBe(110121);
    expect(result.errorText).toContain('110121');
  });

  it('leaves errorCode undefined for non-ExchangeError errors', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.createOrderWebSocket as jest.Mock).mockRejectedValue(
      new Error('connection reset'),
    );

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.errorCode).toBeUndefined();
  });

  // AVAUSDT on Bybit 17.09.2026: errorText carried the log prefix and a doubled code, and the real
  // reason — a risk tier limit — was cut off on the operator's screen and read as a margin shortage.
  it('gives the exchange words as errorText — no log prefix, no doubled code, multi-line intact', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);
    const exchangeWords =
      'Bybit API error 110090: The combined value of positions and orders has reached the limit of the current risk tier.\nOnly reduce-only or close-on-trigger orders are allowed.';

    (connector.futures.createOrderWebSocket as jest.Mock).mockRejectedValue(
      new ExchangeError(exchangeWords, 110090, 'bybit'),
    );

    const result = await connector.createOrder({
      symbol: 'AVAUSDT',
      amount: 1,
      price: 0.19,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Sell,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.errorText).toBe(exchangeWords);
    expect(result.errorCode).toBe(110090);
  });
});

describe('ExchangeConnector Binance futures positionSide', () => {
  function createBinanceConnector(
    futuresPositionMode?: PositionModeEnum
  ): ExchangeConnector {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Binance,
      { apiKey: 'k', secret: 's' } as ExchangeConfig,
      undefined,
      futuresPositionMode,
    );
    (connector.futures.createOrderWebSocket as jest.Mock).mockResolvedValue({
      id: 'oid1',
      symbol: 'BTCUSDT',
    });

    return connector;
  }

  it('omits positionSide for Binance one-way futures when orderParams has no positionSide', async () => {
    const connector = createBinanceConnector(PositionModeEnum.OneWay);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.actualExchangeParams?.positionSide).toBeUndefined();
  });

  it('defaults Binance connector to one-way futuresPositionMode', () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    expect(connector.futuresPositionMode).toBe(PositionModeEnum.OneWay);
  });

  it('auto-infers Long for Binance hedge futures Buy when positionSide missing (open intent)', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
  });

  it('auto-infers Short for Binance hedge futures Sell when positionSide missing (open intent)', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Sell,
      marketType: MarketTypeEnum.Futures,
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
  });

  it('auto-infers Long for Binance hedge close-long (Sell + reduceOnly=true)', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Sell,
      marketType: MarketTypeEnum.Futures,
      reduceOnly: true,
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
  });

  it('auto-infers Short for Binance hedge close-short (Buy + nested params.reduceOnly=true)', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
      params: { reduceOnly: true },
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
  });

  it('uses explicit orderParams.positionSide for Binance hedge futures', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
      positionSide: PositionSideEnum.Long,
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
  });
});

describe('ExchangeConnector mark price cache', () => {
  function createConnectorWithFuturesStream(overrides?: {
    subscribeMarkPrices?: jest.Mock;
    unsubscribeMarkPrices?: jest.Mock;
  }): {
    connector: ExchangeConnector;
    subscribeSpy: jest.Mock;
    unsubscribeSpy: jest.Mock;
    capturedHandler: { value: ((list: MarkPriceUpdate[]) => void) | null };
  } {
    const capturedHandler: { value: MarkPriceHandler | null } = { value: null };
    const subscribeSpy = overrides?.subscribeMarkPrices ?? jest.fn((handler: MarkPriceHandler) => {
      capturedHandler.value = handler;
    });
    const unsubscribeSpy = overrides?.unsubscribeMarkPrices ?? jest.fn();

    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    const futuresMutable = connector.futures as unknown as {
      subscribeMarkPrices: jest.Mock;
      unsubscribeMarkPrices: jest.Mock;
    };
    futuresMutable.subscribeMarkPrices = subscribeSpy;
    futuresMutable.unsubscribeMarkPrices = unsubscribeSpy;

    return { connector, subscribeSpy, unsubscribeSpy, capturedHandler };
  }

  it('subscribeMarkPrices is idempotent — calls underlying subscribe once', () => {
    const { connector, subscribeSpy } = createConnectorWithFuturesStream();
    connector.startWatchingMarkPrices();
    connector.startWatchingMarkPrices();
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('getMarkPrice returns cached update after handler receives it', () => {
    const { connector, capturedHandler } = createConnectorWithFuturesStream();
    connector.startWatchingMarkPrices();

    expect(capturedHandler.value).not.toBeNull();
    capturedHandler.value!([
      { symbol: 'BTCUSDT', markPrice: 50000, indexPrice: 49990, timestamp: 1 },
    ]);

    expect(connector.getMarkPrice('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      markPrice: 50000,
      indexPrice: 49990,
      timestamp: 1,
    });
    expect(connector.getMarkPrice('NONEXISTENT')).toBeUndefined();
  });

  it('ignores updates with markPrice <= 0 or non-finite', () => {
    const { connector, capturedHandler } = createConnectorWithFuturesStream();
    connector.startWatchingMarkPrices();

    capturedHandler.value!([
      { symbol: 'A', markPrice: 100, indexPrice: 100, timestamp: 1 },
    ]);
    capturedHandler.value!([
      { symbol: 'A', markPrice: 0, indexPrice: 0, timestamp: 2 },
    ]);
    capturedHandler.value!([
      { symbol: 'A', markPrice: NaN, indexPrice: 0, timestamp: 3 },
    ]);

    expect(connector.getMarkPrice('A')?.markPrice).toBe(100);
    expect(connector.getMarkPrice('A')?.timestamp).toBe(1);
  });

  it('stopWatchingMarkPrices unsubscribes and clears cache', () => {
    const { connector, capturedHandler, unsubscribeSpy } = createConnectorWithFuturesStream();
    connector.startWatchingMarkPrices();
    capturedHandler.value!([{ symbol: 'X', markPrice: 1, indexPrice: 1, timestamp: 1 }]);

    connector.stopWatchingMarkPrices();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(connector.getMarkPrice('X')).toBeUndefined();
  });
});

describe('ExchangeConnector dynamic write rate-limit on initialize', () => {
  it('creates write queue with effectiveLimit = floor(dynamicRps) when getOrderRateLimit succeeds', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.getOrderRateLimit as jest.Mock).mockResolvedValue({
      writeRequestsPerSecond: 30,
      source: 'binance-exchange-info',
    });

    await connector.initialize();

    // queue is private; observe via positionManager which uses it.
    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).not.toBeNull();
    expect(queue!.getRateLimit()).toBe(30); // floor(30)
    await connector.disconnect();
  });

  it('returns Bybit documented 10 RPS → effective 10 RPS', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.getOrderRateLimit as jest.Mock).mockResolvedValue({
      writeRequestsPerSecond: 10,
      source: 'bybit-documented',
    });

    await connector.initialize();

    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).not.toBeNull();
    expect(queue!.getRateLimit()).toBe(10); // floor(10)
    await connector.disconnect();
  });

  it('falls back to 10 RPS when getOrderRateLimit throws', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.getOrderRateLimit as jest.Mock).mockRejectedValue(new Error('Network error'));

    await connector.initialize();

    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).not.toBeNull();
    expect(queue!.getRateLimit()).toBe(10);
    await connector.disconnect();
  });

  it('uses explicit rateLimitConfig override AS-IS without applying safety factor', async () => {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Binance,
      { apiKey: 'k', secret: 's' } as ExchangeConfig,
      undefined,
      undefined,
      undefined,
      { writeRequestsPerSecond: 10 },
    );

    await connector.initialize();

    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).not.toBeNull();
    expect(queue!.getRateLimit()).toBe(10);
    // getOrderRateLimit must NOT be called when override is provided
    expect(connector.futures.getOrderRateLimit as jest.Mock).not.toHaveBeenCalled();
    await connector.disconnect();
  });

  it('with rateLimitConfig=null does not create a write queue', async () => {
    const connector = new ExchangeConnector(
      ExchangeNameEnum.Binance,
      { apiKey: 'k', secret: 's' } as ExchangeConfig,
      undefined,
      undefined,
      undefined,
      null,
    );

    await connector.initialize();

    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).toBeNull();
    expect(connector.futures.getOrderRateLimit as jest.Mock).not.toHaveBeenCalled();
    await connector.disconnect();
  });

  it('enforces minimum 1 RPS when dynamic value floors to 0', async () => {
    const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    (connector.futures.getOrderRateLimit as jest.Mock).mockResolvedValue({
      writeRequestsPerSecond: 0,
      source: 'fallback',
    });

    await connector.initialize();

    const queue = (connector as unknown as { writeQueue: { getRateLimit(): number } | null }).writeQueue;

    expect(queue).not.toBeNull();
    expect(queue!.getRateLimit()).toBe(1); // Math.max(1, floor(0)=0) → 1
    await connector.disconnect();
  });
});

describe('ExchangeConnector.getFuturesSymbols TRADIFI filter', () => {
  function buildConnectorWithSymbols(): ExchangeConnector {
    const connector = new ExchangeConnector(ExchangeNameEnum.Binance, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    const tradeSymbols = new Map<string, TradeSymbol>([
      ['BTCUSDT', { symbol: 'BTCUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'PERPETUAL', isTradifi: false } as TradeSymbol],
      ['ETHUSDT', { symbol: 'ETHUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'PERPETUAL', isTradifi: false } as TradeSymbol],
      ['AAPLUSDT', { symbol: 'AAPLUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'TRADIFI_PERPETUAL', isTradifi: true } as TradeSymbol],
    ]);
    (connector.futures as unknown as { tradeSymbols: typeof tradeSymbols }).tradeSymbols = tradeSymbols;

    return connector;
  }

  // Bybit lists tokenized TradFi perpetuals with the ordinary 'LinearPerpetual' contractType —
  // only the normalized isTradifi flag (from Bybit symbolType stock/commodity) tells them apart.
  function buildBybitConnectorWithSymbols(): ExchangeConnector {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    const tradeSymbols = new Map<string, TradeSymbol>([
      ['BTCUSDT', { symbol: 'BTCUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'LinearPerpetual', isTradifi: false } as TradeSymbol],
      ['IBMUSDT', { symbol: 'IBMUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'LinearPerpetual', isTradifi: true } as TradeSymbol],
      ['XAUUSDT', { symbol: 'XAUUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'LinearPerpetual', isTradifi: true } as TradeSymbol],
    ]);
    (connector.futures as unknown as { tradeSymbols: typeof tradeSymbols }).tradeSymbols = tradeSymbols;

    return connector;
  }

  it('excludes TRADIFI_PERPETUAL contracts when excludeTradifi is true', async () => {
    const connector = buildConnectorWithSymbols();

    const symbolList = await connector.getFuturesSymbols({ excludeTradifi: true });

    expect(symbolList).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('includes TRADIFI_PERPETUAL contracts by default (backward compatible)', async () => {
    const connector = buildConnectorWithSymbols();

    const symbolList = await connector.getFuturesSymbols();

    expect(symbolList).toEqual(['BTCUSDT', 'ETHUSDT', 'AAPLUSDT']);
  });

  it('excludes Bybit tokenized stocks and commodities when excludeTradifi is true', async () => {
    const symbolList = await buildBybitConnectorWithSymbols().getFuturesSymbols({ excludeTradifi: true });

    expect(symbolList).toEqual(['BTCUSDT']);
  });

  it('includes Bybit tradifi symbols by default', async () => {
    const symbolList = await buildBybitConnectorWithSymbols().getFuturesSymbols();

    expect(symbolList).toEqual(['BTCUSDT', 'IBMUSDT', 'XAUUSDT']);
  });
});

// Only Bybit symbols go through normalizeSymbol: it strips separators and a settle suffix
// ('BTC/USDT:USDT' → 'BTCUSDT'). OKX needs none of that — exchange-engine already joins the
// instrument id parts into a plain name (BTC-USDT-SWAP → BTCUSDT), so the list has to come out
// untouched, including names that legitimately start with a digit.
describe('ExchangeConnector symbol naming for OKX', () => {
  // 'ETH-USDT-SWAP' / 'SOL-USDT' carry the separators normalizeSymbol() strips ('/', ':', '.',
  // '-') — a guard fixture, not a real exchange-engine OKX name (the real normalizer already
  // joins instId parts into a plain 'ETHUSDT'). Without a name shaped like this, applying
  // normalizeSymbol() to every exchange would pass silently: the other fixtures ('BTCUSDT',
  // 'FLOKIUSDT', '1INCHUSDT', 'CFGUSDT') contain none of the characters normalizeSymbol touches.
  function buildOkxConnectorWithSymbols(): ExchangeConnector {
    const connector = new ExchangeConnector(ExchangeNameEnum.Okx, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    const futuresTradeSymbols = new Map<string, TradeSymbol>([
      ['BTCUSDT', { symbol: 'BTCUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'SWAP', isTradifi: false } as TradeSymbol],
      ['FLOKIUSDT', { symbol: 'FLOKIUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'SWAP', isTradifi: false } as TradeSymbol],
      ['1INCHUSDT', { symbol: '1INCHUSDT', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'SWAP', isTradifi: false } as TradeSymbol],
      ['ETH-USDT-SWAP', { symbol: 'ETH-USDT-SWAP', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'SWAP', isTradifi: false } as TradeSymbol],
    ]);
    const spotTradeSymbols = new Map<string, TradeSymbol>([
      ['BTCUSDT', { symbol: 'BTCUSDT', isActive: true, type: TradeSymbolTypeEnum.Spot, isLinear: false, contractType: '', isTradifi: false } as TradeSymbol],
      ['CFGUSDT', { symbol: 'CFGUSDT', isActive: true, type: TradeSymbolTypeEnum.Spot, isLinear: false, contractType: '', isTradifi: false } as TradeSymbol],
      ['SOL-USDT', { symbol: 'SOL-USDT', isActive: true, type: TradeSymbolTypeEnum.Spot, isLinear: false, contractType: '', isTradifi: false } as TradeSymbol],
    ]);

    (connector.futures as unknown as { tradeSymbols: typeof futuresTradeSymbols }).tradeSymbols = futuresTradeSymbols;
    (connector.spot as unknown as { tradeSymbols: typeof spotTradeSymbols }).tradeSymbols = spotTradeSymbols;

    return connector;
  }

  // Same separator-bearing name on Bybit — proves the fixture is actually sensitive to
  // normalizeSymbol(): Bybit must come out stripped where OKX above must come out untouched.
  function buildBybitConnectorWithSeparatorSymbol(): ExchangeConnector {
    const connector = new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);

    const futuresTradeSymbols = new Map<string, TradeSymbol>([
      ['ETH-USDT-SWAP', { symbol: 'ETH-USDT-SWAP', isActive: true, type: TradeSymbolTypeEnum.Swap, isLinear: true, contractType: 'LinearPerpetual', isTradifi: false } as TradeSymbol],
    ]);

    (connector.futures as unknown as { tradeSymbols: typeof futuresTradeSymbols }).tradeSymbols = futuresTradeSymbols;

    return connector;
  }

  it('leaves futures symbols exactly as exchange-engine named them', async () => {
    const symbolList = await buildOkxConnectorWithSymbols().getFuturesSymbols();

    expect(symbolList).toEqual(['BTCUSDT', 'FLOKIUSDT', '1INCHUSDT', 'ETH-USDT-SWAP']);
  });

  it('leaves spot symbols exactly as exchange-engine named them', async () => {
    const symbolList = await buildOkxConnectorWithSymbols().getSpotSymbols();

    expect(symbolList).toEqual(['BTCUSDT', 'CFGUSDT', 'SOL-USDT']);
  });

  it('strips separators for Bybit — the same fixture normalized, unlike OKX above', async () => {
    const symbolList = await buildBybitConnectorWithSeparatorSymbol().getFuturesSymbols();

    expect(symbolList).toEqual(['ETHUSDTSWAP']);
  });
});

describe('ExchangeConnector.createBatchOrders outcome mapping', () => {
  function buildConnector(): ExchangeConnector {
    return new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);
  }

  const orderParamsList = [
    {
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    },
    {
      symbol: 'BTCUSDT',
      amount: 2,
      price: 101,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
    },
  ];

  it('reports the rejected order as failed and carries the exchange reason through', async () => {
    const connector = buildConnector();
    (connector.futures.createBatchOrders as jest.Mock).mockResolvedValue([
      { order: { id: 'ok-1', symbol: 'BTCUSDT' }, isSuccess: true, errorCode: null, errorText: null },
      { order: null, isSuccess: false, errorCode: 110007, errorText: 'Insufficient available balance' },
    ]);

    const resultList = await connector.createBatchOrders(orderParamsList);

    expect(resultList).toHaveLength(2);
    expect(resultList[0].orderId).toBe('ok-1');
    expect(resultList[0].errorText).toBeUndefined();
    expect(resultList[1].orderId).toBeUndefined();
    expect(resultList[1].errorText).toBe('Insufficient available balance');
  });

  it('never reports success for an entry the exchange said nothing about', async () => {
    const connector = buildConnector();
    (connector.futures.createBatchOrders as jest.Mock).mockResolvedValue([
      { order: { id: 'ok-1', symbol: 'BTCUSDT' }, isSuccess: true, errorCode: null, errorText: null },
    ]);

    const resultList = await connector.createBatchOrders(orderParamsList);

    expect(resultList).toHaveLength(2);
    expect(resultList[1].orderId).toBeUndefined();
    expect(resultList[1].errorText).toBe('Order creation failed in batch');
  });
});

describe('ExchangeConnector read and sizing delegates', () => {
  function buildConnector(): ExchangeConnector {
    return new ExchangeConnector(ExchangeNameEnum.Bybit, {
      apiKey: 'k',
      secret: 's',
    } as ExchangeConfig);
  }

  function loadBtcFuturesSymbol(connector: ExchangeConnector): ExchangeClient {
    const client = connector.getClient(MarketTypeEnum.Futures);
    client.tradeSymbols.set('BTCUSDT', {
      symbol: 'BTCUSDT',
      filter: { tickSize: '0.1', stepSize: '0.001', minQty: '0.001', maxQty: '1', minNotional: '5' },
    } as TradeSymbol);
    jest.mocked(client.getMinOrderQty).mockReturnValue(0.001);
    jest.mocked(client.getMinNotional).mockReturnValue(5);
    jest.mocked(client.getMaxOrderQty).mockReturnValue(1);
    jest.mocked(client.getMarketMaxOrderQty).mockReturnValue(0.5);

    return client;
  }

  const kline: Kline = {
    openTimestamp: 1000,
    openPrice: 100,
    highPrice: 110,
    lowPrice: 90,
    closePrice: 105,
    volume: 10,
    closeTimestamp: 1999,
    quoteAssetVolume: 1000,
    numberOfTrades: 5,
    takerBuyBaseAssetVolume: 4,
    takerBuyQuoteAssetVolume: 400,
  };

  it('readKlines reads the market client with the page options', async () => {
    const connector = buildConnector();
    jest.mocked(connector.getClient(MarketTypeEnum.Futures).fetchKlines).mockResolvedValueOnce([kline]);

    const klineList = await connector.readKlines({
      symbol: 'BTCUSDT', interval: '30m', marketType: MarketTypeEnum.Futures, startTime: 1000, limit: 3,
    });

    expect(klineList).toEqual([kline]);
    expect(connector.getClient(MarketTypeEnum.Futures).fetchKlines).toHaveBeenCalledWith('BTCUSDT', '30m', { startTime: 1000, limit: 3 });

    await connector.readKlines({ symbol: 'BTCUSDT', interval: '4h', marketType: MarketTypeEnum.Spot });
    expect(connector.getClient(MarketTypeEnum.Spot).fetchKlines).toHaveBeenCalledWith('BTCUSDT', '4h', {});
  });

  it('readKlines repeats the read after a 429', async () => {
    const connector = buildConnector();
    const fetchKlines = jest.mocked(connector.getClient(MarketTypeEnum.Futures).fetchKlines);
    fetchKlines.mockRejectedValueOnce(
      Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '0' } } }),
    );

    await connector.readKlines({ symbol: 'BTCUSDT', interval: '30m', marketType: MarketTypeEnum.Futures });

    expect(fetchKlines).toHaveBeenCalledTimes(2);
  });

  it('isUserDataStreamConnected answers for futures by default, or for the given market', () => {
    const connector = buildConnector();

    expect(connector.isUserDataStreamConnected()).toBe(true);
    expect(connector.isUserDataStreamConnected(MarketTypeEnum.Spot)).toBe(false);
  });

  it('getRateLimitState answers for futures by default, or for the given market', () => {
    const connector = buildConnector();

    expect(connector.getRateLimitState()).toEqual({ usedWeight: 120, weightLimit: 2400, observedAtMs: 1000, bannedUntilMs: null });
    expect(connector.getRateLimitState(MarketTypeEnum.Spot)).toEqual({ usedWeight: null, weightLimit: null, observedAtMs: null, bannedUntilMs: null });
  });

  it('amountToFuturesPrecision passes the rounding to the futures client', () => {
    const connector = buildConnector();
    const amountToPrecision = jest.spyOn(connector.getClient(MarketTypeEnum.Futures), 'amountToPrecision').mockReturnValue(1.234);

    expect(connector.amountToFuturesPrecision('BTCUSDT', 1.23456, 'down')).toBe(1.234);
    expect(amountToPrecision).toHaveBeenCalledWith('BTCUSDT', 1.23456, 'down');
  });

  it('sizeFuturesOrder sizes on the futures client', () => {
    const connector = buildConnector();
    const client = loadBtcFuturesSymbol(connector);
    const args = { symbol: 'BTCUSDT', notionalUsd: 1500, price: 1000, orderKind: 'limit' as const, requireLoadedSymbol: true };

    const result = connector.sizeFuturesOrder(args);

    expect(result).toEqual({ pieceList: [1, 0.5], totalContracts: 1.5 });
    expect(result).toEqual(sizeOrder({ ...args, exchangeClient: client }));
    expect(connector.sizeFuturesOrder({ ...args, symbol: 'GHOSTUSDT' }).guardError).toContain('GHOSTUSDT');
  });

  it('splitFuturesOrderQty splits by the futures cap', () => {
    const connector = buildConnector();
    const client = loadBtcFuturesSymbol(connector);
    const args = { symbol: 'BTCUSDT', fullQty: 1.25, orderKind: 'market' as const };

    const pieceList = connector.splitFuturesOrderQty(args);

    expect(pieceList).toEqual([0.5, 0.5, 0.25]);
    expect(pieceList).toEqual(splitOrderQty({ ...args, exchangeClient: client }));
  });

  it('assertFuturesSymbolLoaded refuses a symbol whose spec is not loaded', () => {
    const connector = buildConnector();
    loadBtcFuturesSymbol(connector);

    expect(connector.assertFuturesSymbolLoaded({ symbol: 'BTCUSDT', orderKind: 'limit' })).toBeUndefined();
    expect(connector.assertFuturesSymbolLoaded({ symbol: 'GHOSTUSDT', orderKind: 'market' })).toContain('GHOSTUSDT not loaded');
  });
});

describe('ExchangeConnector.createOrder exchange acceptance time', () => {
  const orderParams = {
    symbol: 'BTCUSDT',
    amount: 1,
    price: 100,
    type: OrderTypeEnum.Limit,
    side: OrderSideEnum.Buy,
    marketType: MarketTypeEnum.Futures,
  };

  function buildConnector(exchangeName: ExchangeNameEnum): ExchangeConnector {
    return new ExchangeConnector(exchangeName, { apiKey: 'k', secret: 's' } as ExchangeConfig);
  }

  it('passes the Binance acceptance time into responseData.timestamp', async () => {
    const connector = buildConnector(ExchangeNameEnum.Binance);
    (connector.futures.createOrderWebSocket as jest.Mock).mockResolvedValue({
      id: 'oid1',
      symbol: 'BTCUSDT',
      timestamp: 1700000000000,
      updatedTimestamp: 1700000000123,
    });

    const result = await connector.createOrder(orderParams);

    expect(result.responseData?.timestamp).toBe(1700000000123);
  });

  it('leaves the timestamp undefined when the order carries no usable time', async () => {
    const connector = buildConnector(ExchangeNameEnum.Binance);
    const createOrderMock = connector.futures.createOrderWebSocket as jest.Mock;

    for (const updatedTimestamp of [undefined, 0, Number.NaN, -5]) {
      createOrderMock.mockResolvedValue({ id: 'oid1', symbol: 'BTCUSDT', updatedTimestamp });

      const result = await connector.createOrder(orderParams);

      expect(result.responseData?.timestamp).toBeUndefined();
    }
  });

  it('never passes the Bybit order time through, because exchange-engine fills it from its own clock', async () => {
    const connector = buildConnector(ExchangeNameEnum.Bybit);
    (connector.futures.createOrderWebSocket as jest.Mock).mockResolvedValue({
      id: 'oid1',
      symbol: 'BTCUSDT',
      updatedTimestamp: 1700000000123,
    });

    const result = await connector.createOrder(orderParams);

    expect(result.responseData?.timestamp).toBeUndefined();
  });

  it('passes the acceptance time through for batch orders too', async () => {
    const connector = buildConnector(ExchangeNameEnum.Binance);
    (connector.futures.createBatchOrders as jest.Mock).mockResolvedValue([
      { order: { id: 'ok-1', symbol: 'BTCUSDT', updatedTimestamp: 1700000000456 }, isSuccess: true, errorCode: null, errorText: null },
      { order: { id: 'ok-2', symbol: 'BTCUSDT' }, isSuccess: true, errorCode: null, errorText: null },
    ]);

    const resultList = await connector.createBatchOrders([orderParams, orderParams]);

    expect(resultList[0].responseData?.timestamp).toBe(1700000000456);
    expect(resultList[1].responseData?.timestamp).toBeUndefined();
  });
});
