import {
  ExchangeError,
  ExchangeNameEnum,
  PositionModeEnum,
  PositionSideEnum,
} from '@solncebro/exchange-engine';
import type { MarkPriceHandler, MarkPriceUpdate } from '@solncebro/exchange-engine';

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig, MarketTypeEnum, OrderSideEnum, OrderTypeEnum } from '../src/types';

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
      },
      spot: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn(),
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

  it('sets positionSide Long for Binance hedge futures Buy when orderParams has no positionSide', async () => {
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

  it('sets positionSide Short for Binance hedge futures Sell when orderParams has no positionSide', async () => {
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

  it('uses explicit orderParams.positionSide for Binance hedge futures', async () => {
    const connector = createBinanceConnector(PositionModeEnum.Hedge);

    const result = await connector.createOrder({
      symbol: 'BTCUSDT',
      amount: 1,
      price: 100,
      type: OrderTypeEnum.Limit,
      side: OrderSideEnum.Buy,
      marketType: MarketTypeEnum.Futures,
      positionSide: PositionSideEnum.Short,
    });

    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
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
