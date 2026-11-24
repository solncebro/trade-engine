import {
  ExchangeNameEnum,
  MarginModeEnum,
  MarketTypeEnum,
  MarketUnitEnum,
  OrderFilterEnum,
  OrderSideEnum,
  OrderTypeEnum,
  PositionModeEnum,
  PositionSideEnum,
  TriggerByEnum,
} from '@solncebro/exchange-engine';

import { logger } from '../src/core/logger';
import { RateLimitedRequestQueue } from '../src/core/RateLimitedRequestQueue';
import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';
import { DeadlineExceededError } from '../src/utils/operationDeadline';

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
        createOrderWebSocket: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT' }),
        cancelOrder: jest.fn().mockImplementation(async (_symbol: string, orderId: string) => ({ orderId, isCancelled: true, filledAmount: null })),
        cancelBatchOrders: jest.fn().mockImplementation(async (_symbol: string, orderIdList: string[]) =>
          orderIdList.map(orderId => ({ orderId, isSuccess: true, errorCode: null, errorText: null }))
        ),
        cancelAllOrders: jest.fn().mockResolvedValue(undefined),
        modifyOrder: jest.fn().mockImplementation(async (params: { orderId: string }) => ({
          id: params.orderId,
          symbol: 'BTCUSDT',
        })),
        modifyBatchOrders: jest.fn().mockImplementation(async (orderList: Array<{ orderId: string }>) =>
          orderList.map(({ orderId }) => ({ orderId, isSuccess: true, errorCode: null, errorText: null }))
        ),
        setLeverage: jest.fn().mockImplementation(async (leverage: number) => ({ confirmedLeverage: leverage })),
        addIsolatedPositionMargin: jest.fn().mockResolvedValue(undefined),
        setMarginMode: jest.fn().mockResolvedValue(undefined),
        setPositionMode: jest.fn().mockResolvedValue(undefined),
        fetchPositionMode: jest.fn().mockResolvedValue(undefined),
        fetchPositionSnapshot: jest.fn().mockResolvedValue(null),
        fetchPositionList: jest.fn().mockResolvedValue([]),
        fetchAllPositions: jest.fn().mockResolvedValue([]),
        fetchOrderExecutionSummary: jest.fn().mockResolvedValue({ filledAmount: 2, lastFillTimeMs: 1500 }),
        getOrder: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT', status: 'open' }),
        getOrderByClientOrderId: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT', status: 'open' }),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchOpenConditionalOrders: jest.fn().mockResolvedValue([]),
        fetchFeeRate: jest.fn().mockResolvedValue([]),
        fetchFundingRateHistory: jest.fn().mockResolvedValue([]),
        fetchAccountTrades: jest.fn().mockResolvedValue([]),
        fetchPositionLeverage: jest.fn().mockResolvedValue(null),
        fetchIncome: jest.fn().mockResolvedValue([]),
        fetchOrderHistory: jest.fn().mockResolvedValue([]),
        fetchClosedPnl: jest.fn().mockResolvedValue([]),
        fetchMarkPrice: jest.fn().mockResolvedValue([]),
        fetchBalances: jest.fn().mockResolvedValue({
          totalWalletBalance: 0,
          totalAvailableBalance: 0,
          balanceByAsset: new Map(),
          availableBalanceSource: 'exchange',
        }),
      },
      spot: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT' }),
        cancelOrder: jest.fn().mockImplementation(async (_symbol: string, orderId: string) => ({ orderId, isCancelled: true, filledAmount: null })),
        cancelBatchOrders: jest.fn().mockImplementation(async (_symbol: string, orderIdList: string[]) =>
          orderIdList.map(orderId => ({ orderId, isSuccess: true, errorCode: null, errorText: null }))
        ),
        cancelAllOrders: jest.fn().mockResolvedValue(undefined),
        modifyOrder: jest.fn().mockImplementation(async (params: { orderId: string }) => ({
          id: params.orderId,
          symbol: 'BTCUSDT',
        })),
        modifyBatchOrders: jest.fn().mockImplementation(async (orderList: Array<{ orderId: string }>) =>
          orderList.map(({ orderId }) => ({ orderId, isSuccess: true, errorCode: null, errorText: null }))
        ),
        getOrder: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT', status: 'open' }),
        getOrderByClientOrderId: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT', status: 'open' }),
        fetchOpenOrders: jest.fn().mockResolvedValue([]),
        fetchOpenConditionalOrders: jest.fn().mockResolvedValue([]),
        fetchFeeRate: jest.fn().mockResolvedValue([]),
      },
      close: jest.fn(),
    })),
  };
});

function createConnector(
  exchangeName: ExchangeNameEnum,
  positionMode: PositionModeEnum = PositionModeEnum.OneWay
): ExchangeConnector {
  return new ExchangeConnector(
    exchangeName,
    { apiKey: 'k', secret: 's' } as ExchangeConfig,
    undefined,
    positionMode
  );
}

describe('PositionManager — futures Bybit', () => {
  describe('Hedge mode', () => {
    it('open long: side=Buy, positionSide=Long, no reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.openPositionLimit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
        price: 100,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('open short: side=Sell, positionSide=Short', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
    });

    it('close long: side=Sell, positionSide=Long, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
    });

    it('close short: side=Buy, positionSide=Short, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
    });

    it('SL long: passes side, position side, reduce-only and the trigger price intent', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.side).toBe(OrderSideEnum.Sell);
      expect(args.positionSide).toBe(PositionSideEnum.Long);
      expect(args.reduceOnly).toBe(true);
      expect(args.triggerDirection).toBeUndefined();
      expect(args.triggerBy).toBe(TriggerByEnum.MarkPrice);
      expect(args.closeOnTrigger).toBeUndefined();
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
    });

    it('SL short: passes side and position side', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.side).toBe(OrderSideEnum.Buy);
      expect(args.positionSide).toBe(PositionSideEnum.Short);
      expect(args.triggerDirection).toBeUndefined();
    });

    it('TP long: passes side and position side', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBeUndefined();
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
    });

    it('TP short: passes side and position side', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBeUndefined();
    });
  });

  describe('OneWay mode', () => {
    it('open long: no positionSide, no reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.openPositionLimit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
        price: 100,
      });
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('close long: no positionSide, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
    });

    it('SL long one-way: reduce-only, no position side', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.reduceOnly).toBe(true);
      expect(args.positionSide).toBeUndefined();
      expect(args.triggerDirection).toBeUndefined();
    });

    it('open short: side=Sell, no positionSide, no reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('close short: side=Buy, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
    });

    it('SL short: passes side and position side, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBeUndefined();
      expect(args.reduceOnly).toBe(true);
    });

    it('TP long: passes side and position side, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBeUndefined();
      expect(args.reduceOnly).toBe(true);
    });

    it('TP short: passes side and position side, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBeUndefined();
      expect(args.reduceOnly).toBe(true);
    });
  });
});

describe('PositionManager — futures Binance', () => {
  describe('Hedge mode', () => {
    it('open long: positionSide=LONG, NO reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('close long: positionSide=LONG, NO reduceOnly (Binance hedge prohibits reduceOnly)', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    // Обёртка передаёт НАМЕРЕНИЕ: сторону позиции и по какой цене сверять срабатывание.
    // Какое биржевое поле этому соответствует и где «только уменьшить» запрещено —
    // решает биржевой слой, поэтому здесь этих полей уже нет.
    it('SL long: passes the position side and the trigger price intent', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.positionSide).toBe(PositionSideEnum.Long);
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
      expect(args.triggerBy).toBe(TriggerByEnum.MarkPrice);
      expect(args.workingType).toBeUndefined();
    });

    it('SL short: passes the position side', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.positionSide).toBe(PositionSideEnum.Short);
    });

    it('open short: positionSide=SHORT, NO reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('close short: positionSide=SHORT, side=Buy, NO reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
      expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('TP long: type=TakeProfitMarket, positionSide=LONG', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
      expect(args.positionSide).toBe(PositionSideEnum.Long);
    });

    it('TP short: type=TakeProfitMarket, positionSide=SHORT', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
      expect(args.positionSide).toBe(PositionSideEnum.Short);
    });
  });

  describe('OneWay mode', () => {
    it('open long: no positionSide, no reduceOnly', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
      expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
    });

    it('open short: side=Sell, no positionSide', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    });

    it('close long: reduceOnly=true, no positionSide', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount: 1,
      });
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    });

    it('close short: side=Buy, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.closePositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        amount: 1,
      });
      expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
      expect(result.actualExchangeParams?.reduceOnly).toBe(true);
      expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    });

    it('SL long: type=StopMarket, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
      expect(args.reduceOnly).toBe(true);
    });

    it('SL short: type=StopMarket, side=Buy, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
      expect(args.side).toBe(OrderSideEnum.Buy);
      expect(args.reduceOnly).toBe(true);
    });

    it('TP long: type=TakeProfitMarket, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
      expect(args.reduceOnly).toBe(true);
    });

    it('TP short: type=TakeProfitMarket, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
      expect(args.reduceOnly).toBe(true);
    });
  });
});

describe('PositionManager — spot', () => {
  it('Bybit spot Buy: side=Buy, no positionSide, no reduceOnly', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const result = await conn.positionManager.openPositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      amount: 1,
    });
    expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
    expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
  });

  it('Bybit spot Sell (close long): no positionSide, no reduceOnly', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const result = await conn.positionManager.closePositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      amount: 1,
    });
    expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
    expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
  });

  it('Bybit spot SL post-buy: side=Sell, type=StopMarket, orderFilter=StopOrder', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const result = await conn.positionManager.placeStopLoss({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      triggerPrice: 90,
      amount: 1,
    });
    const args = result.actualExchangeParams!;
    expect(args.side).toBe(OrderSideEnum.Sell);
    expect(args.type).toBe(OrderTypeEnum.StopMarket);
    expect(args.orderFilter).toBe(OrderFilterEnum.StopOrder);
    expect(args.triggerBy).toBeUndefined();
    expect(args.triggerDirection).toBeUndefined();
    expect(args.reduceOnly).toBeUndefined();
    expect(args.positionSide).toBeUndefined();
  });

  it('Binance spot SL post-buy: side=Sell, type=StopMarket (maps to STOP_LOSS), no reduceOnly, no closePosition', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const result = await conn.positionManager.placeStopLoss({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      triggerPrice: 90,
      amount: 1,
    });
    const args = result.actualExchangeParams!;
    expect(args.side).toBe(OrderSideEnum.Sell);
    expect(args.type).toBe(OrderTypeEnum.StopMarket);
    expect(args.reduceOnly).toBeUndefined();
    expect(args.closePosition).toBeUndefined();
    expect(args.workingType).toBeUndefined();
    expect(args.positionSide).toBeUndefined();
  });

  it('Binance spot SL Limit: type=StopLimit (maps to STOP_LOSS_LIMIT)', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const result = await conn.positionManager.placeStopLoss({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      triggerPrice: 90,
      amount: 1,
      orderType: 'Limit',
      limitPrice: 89,
    });
    const args = result.actualExchangeParams!;
    expect(args.type).toBe(OrderTypeEnum.StopLimit);
  });

  it('Bybit spot TP post-buy: side=Sell, type=TakeProfitMarket, orderFilter=StopOrder', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const result = await conn.positionManager.placeTakeProfit({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      triggerPrice: 110,
      amount: 1,
    });
    const args = result.actualExchangeParams!;
    expect(args.side).toBe(OrderSideEnum.Sell);
    expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
    expect(args.orderFilter).toBe('StopOrder');
    expect(args.reduceOnly).toBeUndefined();
  });

  it('Binance spot TP post-buy: type=TakeProfitMarket (maps to TAKE_PROFIT), no closePosition', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const result = await conn.positionManager.placeTakeProfit({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      triggerPrice: 110,
      amount: 1,
    });
    const args = result.actualExchangeParams!;
    expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
    expect(args.closePosition).toBeUndefined();
    expect(args.reduceOnly).toBeUndefined();
  });

  it('spot + direction=short throws synchronously', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    await expect(
      conn.positionManager.openPositionMarket({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Spot,
        direction: 'short',
        amount: 1,
      })
    ).rejects.toThrow('SHORT positions are not supported on spot');

    await expect(
      conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Spot,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      })
    ).rejects.toThrow('SHORT positions are not supported on spot');
  });
});

describe('PositionManager — spotMarketBuyByQuote', () => {
  it('Bybit: marketUnit=quoteCoin, quoteOrderQty set', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const result = await conn.positionManager.spotMarketBuyByQuote({
      symbol: 'BTCUSDT',
      quoteAmount: 100,
    });
    expect(result.actualExchangeParams?.marketUnit).toBe(MarketUnitEnum.QuoteCoin);
    expect(result.actualExchangeParams?.quoteOrderQty).toBe(100);
  });

  it('Binance: quoteOrderQty set, no marketUnit', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const result = await conn.positionManager.spotMarketBuyByQuote({
      symbol: 'BTCUSDT',
      quoteAmount: 100,
    });
    expect(result.actualExchangeParams?.quoteOrderQty).toBe(100);
    expect(result.actualExchangeParams?.marketUnit).toBeUndefined();
  });

  it('OKX: quoteOrderQty set, no marketUnit — the OKX client reads the quote size itself', async () => {
    const conn = createConnector(ExchangeNameEnum.Okx, PositionModeEnum.OneWay);
    const result = await conn.positionManager.spotMarketBuyByQuote({
      symbol: 'BTCUSDT',
      quoteAmount: 100,
    });
    expect(result.actualExchangeParams?.quoteOrderQty).toBe(100);
    expect(result.actualExchangeParams?.marketUnit).toBeUndefined();
  });

  it('throws on non-positive quoteAmount', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    await expect(
      conn.positionManager.spotMarketBuyByQuote({
        symbol: 'BTCUSDT',
        quoteAmount: 0,
      })
    ).rejects.toThrow('positive quoteAmount');
  });
});

describe('PositionManager — futures OKX', () => {
  it('Hedge mode close long: positionSide=Long and reduceOnly=true — the OKX client drops the flag itself', async () => {
    const conn = createConnector(ExchangeNameEnum.Okx, PositionModeEnum.Hedge);
    const result = await conn.positionManager.closePositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
      amount: 1,
    });
    expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Sell);
    expect(result.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Long);
    expect(result.actualExchangeParams?.reduceOnly).toBe(true);
  });

  it('OneWay mode close long: no positionSide, reduceOnly=true', async () => {
    const conn = createConnector(ExchangeNameEnum.Okx, PositionModeEnum.OneWay);
    const result = await conn.positionManager.closePositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
      amount: 1,
    });
    expect(result.actualExchangeParams?.positionSide).toBeUndefined();
    expect(result.actualExchangeParams?.reduceOnly).toBe(true);
  });

  it('open long carries no reduceOnly in either mode', async () => {
    const conn = createConnector(ExchangeNameEnum.Okx, PositionModeEnum.Hedge);
    const result = await conn.positionManager.openPositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
      amount: 1,
    });
    expect(result.actualExchangeParams?.side).toBe(OrderSideEnum.Buy);
    expect(result.actualExchangeParams?.reduceOnly).toBeUndefined();
  });
});

describe('PositionManager — setup helpers', () => {
  it('reads the execution summary outside the write queue and preserves failures', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const queue = new RateLimitedRequestQueue({ rateLimit: 100 });
    jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
    const execute = jest.spyOn(queue, 'execute');
    const args = { marketType: MarketTypeEnum.Futures, symbol: 'BTCUSDT', orderId: '77', startTime: 1000, endTime: 2000 };
    await expect(conn.positionManager.readOrderExecutionSummary(args)).resolves.toEqual({ filledAmount: 2, lastFillTimeMs: 1500 });
    expect(execute).not.toHaveBeenCalled();
    expect(conn.futures.fetchOrderExecutionSummary).toHaveBeenCalledWith({ symbol: 'BTCUSDT', orderId: '77', startTime: 1000, endTime: 2000 });
    (conn.futures.fetchOrderExecutionSummary as jest.Mock).mockRejectedValueOnce(new Error('history unavailable'));
    await expect(conn.positionManager.readOrderExecutionSummary(args)).rejects.toThrow('history unavailable');
  });

  it('openPositionLimit calls setLeverage and setMarginMode for futures', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const setLevSpy = conn.futures.setLeverage as jest.Mock;
    const setMarginSpy = conn.futures.setMarginMode as jest.Mock;

    await conn.positionManager.openPositionLimit({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
      amount: 1,
      price: 100,
      leverage: 5,
      marginMode: MarginModeEnum.Isolated,
    });

    expect(setLevSpy).toHaveBeenCalledWith(5, 'BTCUSDT');
    expect(setMarginSpy).toHaveBeenCalledWith(MarginModeEnum.Isolated, 'BTCUSDT');
  });

  // Подтверждение плеча — факт из ответа биржи, и оно обязано дойти до вызывающего нетронутым:
  // потребители, ставящие плечо заранее вслепую, сверяют его с настройкой (rubber, 14.08.2026).
  it('holds the symbol until the first leveraged limit order finishes', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    let releaseOrder: () => void = () => undefined;
    let markOrderStarted: () => void = () => undefined;
    const orderStarted = new Promise<void>(resolve => { markOrderStarted = resolve; });
    const orderPending = new Promise<void>(resolve => { releaseOrder = resolve; });
    const createOrder = jest.spyOn(conn, 'createOrder').mockImplementationOnce(async orderParams => {
      markOrderStarted();
      await orderPending;

      return { orderId: 'first', orderParams, exchangeName: ExchangeNameEnum.Bybit };
    });
    const first = conn.positionManager.openPositionLimitWithLeverage({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long',
      leverage: 7, amount: 0.01, price: 50000,
    });
    await orderStarted;
    const second = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 4, direction: 'short' });
    await Promise.resolve();
    await Promise.resolve();

    expect(conn.futures.setLeverage).toHaveBeenCalledTimes(1);
    expect(conn.futures.setLeverage).toHaveBeenCalledWith(7, 'BTCUSDT', { direction: 'long' });
    releaseOrder();
    await first;
    await second;
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(conn.futures.setLeverage).toHaveBeenLastCalledWith(4, 'BTCUSDT', { direction: 'short' });
  });

  it('does not create the first limit order when leverage is rejected', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.setLeverage as jest.Mock).mockRejectedValueOnce(new Error('leverage rejected'));
    const createOrder = jest.spyOn(conn, 'createOrder');

    await expect(conn.positionManager.openPositionLimitWithLeverage({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long',
      leverage: 7, amount: 0.01, price: 50000,
    })).rejects.toThrow('leverage rejected');
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('does not create the first limit order when beforeOrder fails', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const createOrder = jest.spyOn(conn, 'createOrder');
    const beforeOrder = jest.fn().mockRejectedValueOnce(new Error('save rejected'));

    await expect(conn.positionManager.openPositionLimitWithLeverage({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long',
      leverage: 7, amount: 0.01, price: 50000, beforeOrder,
    })).rejects.toThrow('save rejected');
    expect(beforeOrder).toHaveBeenCalledTimes(1);
    expect(conn.futures.setLeverage).toHaveBeenCalledTimes(1);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it.each([true, false])('checks the deadline after the write queue with leverage=%s', async shouldSetLeverage => {
    jest.useFakeTimers({ now: 1000 });

    try {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const queue = new RateLimitedRequestQueue({ rateLimit: 1, intervalMs: 1000 });
      jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
      const createOrder = jest.spyOn(conn, 'createOrder');

      if (!shouldSetLeverage) await queue.execute(async () => undefined);

      const beforeOrder = jest.fn(async () => {
        if (Date.now() >= 1500) throw new Error('signal expired');
      });
      const args = {
        symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long' as const,
        leverage: 7, amount: 0.01, price: 50000, beforeOrder,
      };
      const request = shouldSetLeverage
        ? conn.positionManager.openPositionLimitWithLeverage(args)
        : conn.positionManager.openPositionLimit({ ...args, leverage: undefined });
      const outcome = request.then(() => 'sent', error => String(error));
      await jest.advanceTimersByTimeAsync(1000);
      expect(await outcome).toContain('signal expired');
      expect(beforeOrder).toHaveBeenCalledTimes(1);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['market-close', 'limit-close', 'market-entry'] as const)('checks a queued %s order immediately before sending', async kind => {
    jest.useFakeTimers({ now: 1000 });

    try {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const queue = new RateLimitedRequestQueue({ rateLimit: 1, intervalMs: 1000 });
      jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
      const createOrder = jest.spyOn(conn, 'createOrder');
      await queue.execute(async () => undefined);
      let isCurrent = true;
      const beforeOrder = jest.fn(async () => {
        if (!isCurrent) throw new Error('close superseded');
      });
      const args = { symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short' as const, amount: 0.01, beforeOrder };
      let request: ReturnType<typeof conn.positionManager.closePositionMarket>;

      if (kind === 'market-entry') {
        request = conn.positionManager.openPositionMarket(args);
      } else if (kind === 'market-close') {
        request = conn.positionManager.closePositionMarket(args);
      } else {
        request = conn.positionManager.closePositionLimit({ ...args, price: 50000 });
      }
      const outcome = request.then(() => 'sent', error => String(error));
      expect(beforeOrder).not.toHaveBeenCalled();
      isCurrent = false;
      await jest.advanceTimersByTimeAsync(1000);
      expect(await outcome).toContain('close superseded');
      expect(beforeOrder).toHaveBeenCalledTimes(1);
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([null, 6])('refuses an unconfirmed first-order leverage %s', async confirmedLeverage => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.setLeverage as jest.Mock).mockResolvedValueOnce({ confirmedLeverage });
    const createOrder = jest.spyOn(conn, 'createOrder');

    await expect(conn.positionManager.openPositionLimitWithLeverage({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long',
      leverage: 7, amount: 0.01, price: 50000,
    })).rejects.toThrow('Leverage was not confirmed');
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('setLeverage forwards the requested direction', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const setLevSpy = conn.futures.setLeverage as jest.Mock;

    await conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 7, direction: 'long' });

    expect(setLevSpy).toHaveBeenCalledWith(7, 'BTCUSDT', { direction: 'long' });
  });

  it('setLeverage passes the exchange-confirmed leverage through to the caller', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const setLevSpy = conn.futures.setLeverage as jest.Mock;
    setLevSpy.mockResolvedValueOnce({ confirmedLeverage: 7 });

    const result = await conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 7 });

    expect(result.confirmedLeverage).toBe(7);
  });

  it('setLeverage passes an unconfirmed (null) answer through untouched — no echo of the request', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const setLevSpy = conn.futures.setLeverage as jest.Mock;
    setLevSpy.mockResolvedValueOnce({ confirmedLeverage: null });

    const result = await conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 7 });

    expect(result.confirmedLeverage).toBeNull();
  });

  it('openPositionLimit on spot does NOT call setLeverage', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const setLevSpy = conn.futures.setLeverage as jest.Mock;
    setLevSpy.mockClear();

    await conn.positionManager.openPositionLimit({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      direction: 'long',
      amount: 1,
      price: 100,
      leverage: 5,
    });

    expect(setLevSpy).not.toHaveBeenCalled();
  });
});

// rubber sets leverage ahead of the kline close under its own cap; a hanging request must not keep
// the symbol's queue — and the entry order queued behind it — after that cap (22.11.2026).
describe('PositionManager — setLeverage deadline', () => {
  const hangingSetLeverage = (): jest.Mock => {
    const signalList: Array<AbortSignal | undefined> = [];
    const mock = jest.fn((_leverage: number, _symbol: string, options?: { signal?: AbortSignal }) => {
      signalList.push(options?.signal);

      return new Promise(() => undefined);
    });

    Object.assign(mock, { signalList });

    return mock;
  };

  const make429 = (retryAfterSeconds: number): Error => Object.assign(new Error('Too many requests'), {
    response: { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: 1000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a hanging request with DeadlineExceededError no later than the deadline and aborts it', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLeverageMock = hangingSetLeverage();
    (conn.futures.setLeverage as jest.Mock).mockImplementationOnce(setLeverageMock);
    let settledAtMs: number | null = null;
    const outcome = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 })
      .then(() => 'resolved', (error: unknown) => error)
      .finally(() => { settledAtMs = Date.now(); });

    await jest.advanceTimersByTimeAsync(7999);
    expect(settledAtMs).toBeNull();
    await jest.advanceTimersByTimeAsync(1);

    const error = await outcome;

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ timeoutMs: 8000, operationLabel: 'setLeverage BTCUSDT leverage=5' });
    expect(settledAtMs).toBe(9000);
    const { signalList } = setLeverageMock as jest.Mock & { signalList: Array<AbortSignal | undefined> };
    expect(signalList).toHaveLength(1);
    expect(signalList[0]?.aborted).toBe(true);
    expect(signalList[0]?.reason).toBe(error);
  });

  it('lets the entry order of the same symbol go at the deadline without waiting for the hanging request', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.setLeverage as jest.Mock).mockImplementationOnce(hangingSetLeverage());
    const createOrder = jest.spyOn(conn, 'createOrder');
    const leverage = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 }).catch((error: unknown) => error);
    const entry = conn.positionManager.openPositionLimit({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 0.01, price: 50000,
    });

    await jest.advanceTimersByTimeAsync(7999);
    expect(createOrder).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await entry;

    expect(await leverage).toBeInstanceOf(DeadlineExceededError);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it('starts neither a retry nor a Retry-After pause once the deadline ran out', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLev = conn.futures.setLeverage as jest.Mock;
    setLev.mockClear();
    setLev.mockRejectedValue(make429(60));
    const outcome = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 }).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(8000);
    expect(await outcome).toBeInstanceOf(DeadlineExceededError);
    await jest.advanceTimersByTimeAsync(300_000);

    expect(setLev).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the deadline ran out while the call still waited behind another operation of the symbol', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLev = conn.futures.setLeverage as jest.Mock;
    let releaseOrder: () => void = () => undefined;
    const orderPending = new Promise<void>(resolve => { releaseOrder = resolve; });
    jest.spyOn(conn, 'createOrder').mockImplementationOnce(async orderParams => {
      await orderPending;

      return { orderId: 'first', orderParams, exchangeName: ExchangeNameEnum.Binance };
    });
    setLev.mockClear();
    const entry = conn.positionManager.openPositionLimit({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 0.01, price: 50000,
    });
    const outcome = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 }).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(8000);
    expect(await outcome).toBeInstanceOf(DeadlineExceededError);
    releaseOrder();
    await entry;
    await jest.advanceTimersByTimeAsync(1000);

    expect(setLev).not.toHaveBeenCalled();
  });

  it('keeps no leverage memory after an unknown outcome: the next set really goes to the exchange', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLev = conn.futures.setLeverage as jest.Mock;
    let answerLate: (value: { confirmedLeverage: number }) => void = () => undefined;
    setLev.mockClear();
    setLev.mockImplementationOnce(() => new Promise(resolve => { answerLate = resolve; }));
    const first = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 }).catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(8000);
    expect(await first).toBeInstanceOf(DeadlineExceededError);
    answerLate({ confirmedLeverage: 5 });
    await jest.advanceTimersByTimeAsync(0);

    const second = await conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs: 8000 });

    expect(setLev).toHaveBeenCalledTimes(2);
    expect(second.confirmedLeverage).toBe(5);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the deadline %s without touching the exchange', async timeoutMs => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLev = conn.futures.setLeverage as jest.Mock;
    setLev.mockClear();

    await expect(conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5, timeoutMs })).rejects.toThrow('timeoutMs must be a non-negative finite number');
    expect(setLev).not.toHaveBeenCalled();
  });

  it('forwards the direction together with the deadline signal', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const setLev = conn.futures.setLeverage as jest.Mock;
    setLev.mockClear();

    await conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 7, direction: 'long', timeoutMs: 8000 });

    expect(setLev.mock.calls[0][2]).toEqual({ direction: 'long', signal: expect.any(AbortSignal) });
    expect(setLev.mock.calls[0][2].signal.aborted).toBe(false);
  });

  it('without a deadline keeps waiting for a slow answer, holds the entry behind it and sends the same call as before', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setLev = conn.futures.setLeverage as jest.Mock;
    setLev.mockClear();
    setLev.mockImplementationOnce((leverage: number) => new Promise(resolve => {
      setTimeout(() => resolve({ confirmedLeverage: leverage }), 60_000);
    }));
    const createOrder = jest.spyOn(conn, 'createOrder');
    const leverage = conn.positionManager.setLeverage({ symbol: 'BTCUSDT', leverage: 5 });
    const entry = conn.positionManager.openPositionLimit({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 0.01, price: 50000,
    });

    await jest.advanceTimersByTimeAsync(59_999);
    expect(createOrder).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect((await leverage).confirmedLeverage).toBe(5);
    await entry;
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(setLev.mock.calls[0]).toEqual([5, 'BTCUSDT']);
  });
});

describe('PositionManager — account reads', () => {
  it('reads account trades outside the write queue with the exchange page options', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const queue = new RateLimitedRequestQueue({ rateLimit: 100 });
    jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
    const execute = jest.spyOn(queue, 'execute');
    const trade = { id: '5', symbol: 'BTCUSDT', side: OrderSideEnum.Buy, positionSide: PositionSideEnum.Long, quantity: 0.01, price: 62000, timestamp: 1500 };
    (conn.futures.fetchAccountTrades as jest.Mock).mockResolvedValueOnce([trade]);

    await expect(conn.positionManager.readAccountTrades({
      marketType: MarketTypeEnum.Futures, symbol: 'BTCUSDT', startTime: 1000, endTime: 2000,
    })).resolves.toEqual([trade]);
    expect(conn.futures.fetchAccountTrades).toHaveBeenCalledWith('BTCUSDT', { startTime: 1000, endTime: 2000 });
    expect(execute).not.toHaveBeenCalled();
    (conn.futures.fetchAccountTrades as jest.Mock).mockRejectedValueOnce(new Error('history unavailable'));
    await expect(conn.positionManager.readAccountTrades({ marketType: MarketTypeEnum.Futures, symbol: 'BTCUSDT' })).rejects.toThrow('history unavailable');
  });

  it('reads the position leverage outside the write queue and keeps an unknown value', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const queue = new RateLimitedRequestQueue({ rateLimit: 100 });
    jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
    const execute = jest.spyOn(queue, 'execute');
    (conn.futures.fetchPositionLeverage as jest.Mock).mockResolvedValueOnce(7).mockResolvedValueOnce(null);

    await expect(conn.positionManager.readPositionLeverage('BTCUSDT')).resolves.toBe(7);
    await expect(conn.positionManager.readPositionLeverage('BTCUSDT')).resolves.toBeNull();
    expect(conn.futures.fetchPositionLeverage).toHaveBeenCalledWith('BTCUSDT');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('PositionManager — history, mark price, balance and open order reads', () => {
  function buildRateLimitedError(): Error {
    return Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '0' } } });
  }

  it('readIncome passes the filter through outside the write queue', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const queue = new RateLimitedRequestQueue({ rateLimit: 100 });
    jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
    const execute = jest.spyOn(queue, 'execute');
    const income = { symbol: 'BTCUSDT', kind: 'funding', amount: -0.5, asset: 'USDT', time: 1500 };
    (conn.futures.fetchIncome as jest.Mock).mockResolvedValueOnce([income]);

    await expect(conn.positionManager.readIncome({ symbol: 'BTCUSDT', incomeType: 'funding', startTime: 1000 })).resolves.toEqual([income]);
    expect(conn.futures.fetchIncome).toHaveBeenCalledWith({ symbol: 'BTCUSDT', incomeType: 'funding', startTime: 1000 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('readIncome reads the whole account when no filter is given', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);

    await expect(conn.positionManager.readIncome()).resolves.toEqual([]);
    expect(conn.futures.fetchIncome).toHaveBeenCalledWith({});
  });

  it('readOrderHistory reads the market client with the page options', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const order = { id: 'h1', symbol: 'BTCUSDT', status: 'closed' };
    (conn.futures.fetchOrderHistory as jest.Mock).mockResolvedValueOnce([order]);

    const result = await conn.positionManager.readOrderHistory({
      symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, startTime: 1000, limit: 50,
    });

    expect(result).toEqual([order]);
    expect(conn.futures.fetchOrderHistory).toHaveBeenCalledWith('BTCUSDT', { startTime: 1000, limit: 50 });
  });

  it('readClosedPnl passes the symbol and page options, or none', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const closedPnl = { symbol: 'BTCUSDT', closedPnl: 12.5 };
    (conn.futures.fetchClosedPnl as jest.Mock).mockResolvedValueOnce([closedPnl]);

    await expect(conn.positionManager.readClosedPnl({ symbol: 'BTCUSDT', startTime: 1000 })).resolves.toEqual([closedPnl]);
    expect(conn.futures.fetchClosedPnl).toHaveBeenCalledWith('BTCUSDT', { startTime: 1000 });

    await expect(conn.positionManager.readClosedPnl()).resolves.toEqual([]);
    expect(conn.futures.fetchClosedPnl).toHaveBeenLastCalledWith(undefined, {});
  });

  it('readMarkPrice picks the row of the symbol, else the first row, else null', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const ethRow = { symbol: 'ETHUSDT', markPrice: 3000, lastFundingRate: 0.0001, nextFundingTime: 2000, timestamp: 1000 };
    const btcRow = { symbol: 'BTCUSDT', markPrice: 60000, lastFundingRate: 0.0001, nextFundingTime: 2000, timestamp: 1000 };
    (conn.futures.fetchMarkPrice as jest.Mock)
      .mockResolvedValueOnce([ethRow, btcRow])
      .mockResolvedValueOnce([ethRow])
      .mockResolvedValueOnce([]);

    await expect(conn.positionManager.readMarkPrice('BTCUSDT')).resolves.toEqual(btcRow);
    await expect(conn.positionManager.readMarkPrice('BTCUSDT')).resolves.toEqual(ethRow);
    await expect(conn.positionManager.readMarkPrice('BTCUSDT')).resolves.toBeNull();
    expect(conn.futures.fetchMarkPrice).toHaveBeenCalledWith('BTCUSDT');
  });

  it('readMarkPrice rethrows a failed read', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchMarkPrice as jest.Mock).mockRejectedValueOnce(new Error('mark price unavailable'));

    await expect(conn.positionManager.readMarkPrice('BTCUSDT')).rejects.toThrow('mark price unavailable');
  });

  it('readAccountBalance reads the futures balance and answers null on a refused read', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchBalances as jest.Mock)
      .mockResolvedValueOnce({
        totalWalletBalance: 100,
        totalAvailableBalance: 70,
        totalInitialMargin: 25,
        balanceByAsset: new Map(),
        availableBalanceSource: 'exchange',
      })
      .mockRejectedValueOnce(new Error('balance unavailable'));

    await expect(conn.positionManager.readAccountBalance()).resolves.toEqual({ totalUsd: 100, availableUsd: 70, usedUsd: 25 });
    await expect(conn.positionManager.readAccountBalance()).resolves.toBeNull();
  });

  it('readOpenPlainOrderList reads one symbol or the whole account of the market', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const order = { id: 'o1', symbol: 'BTCUSDT', status: 'open' };
    (conn.futures.fetchOpenOrders as jest.Mock).mockResolvedValueOnce([order]).mockResolvedValueOnce([order]);

    await expect(conn.positionManager.readOpenPlainOrderList({ marketType: MarketTypeEnum.Futures, symbol: 'BTCUSDT' })).resolves.toEqual([order]);
    expect(conn.futures.fetchOpenOrders).toHaveBeenLastCalledWith('BTCUSDT');

    await expect(conn.positionManager.readOpenPlainOrderList({ marketType: MarketTypeEnum.Futures })).resolves.toEqual([order]);
    expect(conn.futures.fetchOpenOrders).toHaveBeenLastCalledWith(undefined);
    expect(conn.futures.fetchOpenConditionalOrders).not.toHaveBeenCalled();

    await conn.positionManager.readOpenPlainOrderList({ marketType: MarketTypeEnum.Spot, symbol: 'BTCUSDT' });
    expect(conn.spot.fetchOpenOrders).toHaveBeenCalledWith('BTCUSDT');
  });

  it('readOpenConditionalOrderList reads the whole USDT account by default', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const btcOrder = { id: 'c1', symbol: 'BTCUSDT', status: 'open', isConditional: true };
    const ethOrder = { id: 'c2', symbol: 'ETHUSDT', status: 'open', isConditional: true };
    (conn.futures.fetchOpenConditionalOrders as jest.Mock).mockResolvedValue([btcOrder, ethOrder]);

    await expect(conn.positionManager.readOpenConditionalOrderList()).resolves.toEqual([btcOrder, ethOrder]);
    expect(conn.futures.fetchOpenConditionalOrders).toHaveBeenLastCalledWith('USDT', undefined);

    await conn.positionManager.readOpenConditionalOrderList({ settleCoin: 'USDC' });
    expect(conn.futures.fetchOpenConditionalOrders).toHaveBeenLastCalledWith('USDC', undefined);
    expect(conn.futures.fetchOpenOrders).not.toHaveBeenCalled();
  });

  it('readOpenConditionalOrderList asks the exchange for the one symbol instead of reading the account', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const btcOrder = { id: 'c1', symbol: 'BTCUSDT', status: 'open', isConditional: true };
    (conn.futures.fetchOpenConditionalOrders as jest.Mock).mockResolvedValue([btcOrder]);

    await expect(conn.positionManager.readOpenConditionalOrderList({ symbol: 'BTCUSDT' })).resolves.toEqual([btcOrder]);
    expect(conn.futures.fetchOpenConditionalOrders).toHaveBeenCalledTimes(1);
    expect(conn.futures.fetchOpenConditionalOrders).toHaveBeenCalledWith('USDT', 'BTCUSDT');
  });

  it.each([
    ['readIncome', 'fetchIncome', (conn: ExchangeConnector) => conn.positionManager.readIncome()],
    ['readOrderHistory', 'fetchOrderHistory', (conn: ExchangeConnector) => conn.positionManager.readOrderHistory({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures })],
    ['readClosedPnl', 'fetchClosedPnl', (conn: ExchangeConnector) => conn.positionManager.readClosedPnl()],
    ['readMarkPrice', 'fetchMarkPrice', (conn: ExchangeConnector) => conn.positionManager.readMarkPrice('BTCUSDT')],
    ['readOpenPlainOrderList', 'fetchOpenOrders', (conn: ExchangeConnector) => conn.positionManager.readOpenPlainOrderList({ marketType: MarketTypeEnum.Futures })],
    ['readOpenConditionalOrderList', 'fetchOpenConditionalOrders', (conn: ExchangeConnector) => conn.positionManager.readOpenConditionalOrderList()],
  ] as const)('%s repeats the read after a 429', async (_name, clientMethodName, read) => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const clientMethod = conn.futures[clientMethodName] as jest.Mock;
    clientMethod.mockRejectedValueOnce(buildRateLimitedError());

    await read(conn);

    expect(clientMethod).toHaveBeenCalledTimes(2);
  });
});

describe('PositionManager — funding rate history', () => {
  it('reads normalized pages outside the write queue and converts rates to percent', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance);
    const queue = new RateLimitedRequestQueue({ rateLimit: 100 });
    jest.spyOn(conn, 'getWriteQueue').mockReturnValue(queue);
    const execute = jest.spyOn(queue, 'execute');
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      symbol: 'BTCUSDT',
      fundingRate: index === 0 ? 0.0001 : 0.0002,
      fundingTime: 1000 + index,
      markPrice: index === 0 ? 62123.4 : null,
    }));
    (conn.futures.fetchFundingRateHistory as jest.Mock)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([]);

    const result = await conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT',
      startTime: 1000,
      endTime: 3000,
      shouldIncludeMarkPrices: true,
    });

    expect(result?.[0]).toEqual({
      symbol: 'BTCUSDT',
      fundingRatePercent: 0.01,
      fundingTime: 1000,
      markPrice: 62123.4,
    });
    expect(result).toHaveLength(1000);
    expect(conn.futures.fetchFundingRateHistory).toHaveBeenNthCalledWith(1, 'BTCUSDT', {
      startTime: 1000,
      endTime: 3000,
      limit: 1000,
      shouldIncludeMarkPrices: true,
    });
    expect(conn.futures.fetchFundingRateHistory).toHaveBeenNthCalledWith(2, 'BTCUSDT', {
      startTime: 2000,
      endTime: 3000,
      limit: 1000,
      shouldIncludeMarkPrices: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns an empty list when the exchange has no entry at the requested instant', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance);

    await expect(conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT',
      startTime: 1000,
      endTime: 1000,
    })).resolves.toEqual([]);
  });

  it('deduplicates repeated entries inside a page', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance);
    (conn.futures.fetchFundingRateHistory as jest.Mock)
      .mockResolvedValueOnce([
        { symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 1999, markPrice: null },
        { symbol: 'BTCUSDT', fundingRate: 0.0002, fundingTime: 1999, markPrice: null },
      ])
      .mockResolvedValue([]);

    const result = await conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT', startTime: 1000, endTime: 3000,
    });

    expect(result).toHaveLength(1);
    expect(result?.at(-1)?.fundingRatePercent).toBe(0.02);
  });

  // Shapes from live answers (04.11.2026): Bybit accepted limit=1000 but returned 200 entries, newest
  // first; Binance returned 1000 entries, oldest first from the start time.
  const EIGHT_HOURS_MS = 28_800_000;
  const fundingTimeList = Array.from({ length: 1200 }, (_, index) => 1_000_000 + index * EIGHT_HOURS_MS);

  function pageOf(symbol: string, timeList: number[]) {
    return timeList.map(fundingTime => ({ symbol, fundingRate: 0.0001, fundingTime, markPrice: null }));
  }

  it('reads past a short page when the exchange returns the newest entries first (Bybit)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit);
    const expectedList = fundingTimeList.slice(0, 360);
    (conn.futures.fetchFundingRateHistory as jest.Mock).mockImplementation(async (symbol: string, options: { startTime: number; endTime: number }) =>
      pageOf(symbol, expectedList.filter(time => time >= options.startTime && time <= options.endTime).reverse().slice(0, 200)));

    const result = await conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT', startTime: 0, endTime: (expectedList.at(-1) ?? 0) + 1,
    });

    expect(result?.map(item => item.fundingTime)).toEqual(expectedList);
  });

  it('reads every page when the exchange returns the oldest entries first (Binance)', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance);
    (conn.futures.fetchFundingRateHistory as jest.Mock).mockImplementation(async (symbol: string, options: { startTime: number; endTime: number }) =>
      pageOf(symbol, fundingTimeList.filter(time => time >= options.startTime && time <= options.endTime).slice(0, 1000)));

    const result = await conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT', startTime: 0, endTime: (fundingTimeList.at(-1) ?? 0) + 1,
    });

    expect(result?.map(item => item.fundingTime)).toEqual(fundingTimeList);
  });

  it('returns null when a repeated full page does not advance', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance);
    const repeatedPage = Array.from({ length: 1000 }, () => ({
      symbol: 'BTCUSDT', fundingRate: 0.0001, fundingTime: 1000, markPrice: null,
    }));
    (conn.futures.fetchFundingRateHistory as jest.Mock)
      .mockResolvedValueOnce(repeatedPage)
      .mockResolvedValueOnce(repeatedPage);

    await expect(conn.positionManager.readFundingRateHistory({
      symbol: 'BTCUSDT', startTime: 1000, endTime: 3000,
    })).resolves.toBeNull();
    expect(conn.futures.fetchFundingRateHistory).toHaveBeenCalledTimes(2);
  });
});

describe('PositionManager — position mode', () => {
  it('setPositionMode switches the account, then orders carry the position side', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const setModeSpy = conn.futures.setPositionMode as jest.Mock;
    const openArgs = { symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short' as const, amount: 1 };

    const before = await conn.positionManager.openPositionMarket(openArgs);

    expect(before.actualExchangeParams?.positionSide).toBeUndefined();

    await conn.positionManager.setPositionMode({ mode: PositionModeEnum.Hedge });
    const after = await conn.positionManager.openPositionMarket(openArgs);

    expect(setModeSpy).toHaveBeenCalledWith(PositionModeEnum.Hedge);
    expect(conn.futuresPositionMode).toBe(PositionModeEnum.Hedge);
    expect(after.actualExchangeParams?.positionSide).toBe(PositionSideEnum.Short);
  });

  it('a refused switch keeps the old mode', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.setPositionMode as jest.Mock).mockRejectedValueOnce(new Error('position exists'));

    await expect(conn.positionManager.setPositionMode({ mode: PositionModeEnum.Hedge })).rejects.toThrow('position exists');
    expect(conn.futuresPositionMode).toBe(PositionModeEnum.OneWay);
  });

  it('readPositionMode passes the exchange answer through, undefined included', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionMode as jest.Mock).mockResolvedValueOnce(PositionModeEnum.Hedge);

    expect(await conn.positionManager.readPositionMode()).toBe(PositionModeEnum.Hedge);
    expect(await conn.positionManager.readPositionMode()).toBeUndefined();
  });
});

describe('PositionManager — cancel routing', () => {
  it('cancelOrder routes to spot client for marketType=Spot', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const spotSpy = conn.spot.cancelOrder as jest.Mock;
    const futSpy = conn.futures.cancelOrder as jest.Mock;
    spotSpy.mockClear();
    futSpy.mockClear();

    await conn.positionManager.cancelOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      orderId: 'oid1',
    });

    expect(spotSpy).toHaveBeenCalledWith('BTCUSDT', 'oid1');
    expect(futSpy).not.toHaveBeenCalled();
  });

  // Исход отмены — ответ биржи на неё саму: одно обращение, без чтения заявки после.
  it.each([
    ['Binance plain order: the answer carries the fill', { orderId: '2395886953', isCancelled: true, filledAmount: 0 }],
    ['Bybit or a conditional order: the fill is unknown', { orderId: '2d113348-463b-406f-870a-3f1cc5deacc1', isCancelled: true, filledAmount: null }],
  ])('cancelOrder returns the cancel outcome (%s) in one call, reading nothing back', async (_label, outcome) => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelOrder as jest.Mock;
    const getOrderSpy = conn.futures.getOrder as jest.Mock;
    futSpy.mockClear();
    getOrderSpy.mockClear();
    futSpy.mockResolvedValueOnce(outcome);

    const result = await conn.positionManager.cancelOrder({
      symbol: 'DOGEUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: outcome.orderId,
    });

    expect(result).toEqual(outcome);
    expect(futSpy).toHaveBeenCalledTimes(1);
    expect(getOrderSpy).not.toHaveBeenCalled();
  });

  it('cancelOrder keeps the exchange error with its code (order already gone)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelOrder as jest.Mock;
    futSpy.mockRejectedValueOnce(Object.assign(new Error('Bybit API error 110001: order not exists or too late to cancel'), { code: 110001 }));

    await expect(conn.positionManager.cancelOrder({
      symbol: 'DOGEUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: 'gone',
    })).rejects.toMatchObject({ code: 110001 });
  });

  it('cancelBatchOrders routes to futures client for marketType=Futures', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelBatchOrders as jest.Mock;
    futSpy.mockClear();

    await conn.positionManager.cancelBatchOrders({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderIdList: ['o1', 'o2'],
    });

    expect(futSpy).toHaveBeenCalledWith('BTCUSDT', ['o1', 'o2']);
  });

  it('cancelBatchOrders is no-op on empty list', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelBatchOrders as jest.Mock;
    futSpy.mockClear();

    await conn.positionManager.cancelBatchOrders({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderIdList: [],
    });

    expect(futSpy).not.toHaveBeenCalled();
  });
});

describe('PositionManager — cancelBatchOrders return type + counts', () => {
  it('returns CancelBatchOrdersResult mapped from client response', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelBatchOrders as jest.Mock;
    futSpy.mockReset();
    futSpy.mockResolvedValueOnce([
      { orderId: 'o1', isSuccess: true, errorCode: null, errorText: null },
      { orderId: 'o2', isSuccess: false, errorCode: -2011, errorText: 'Unknown order sent.' },
      { orderId: 'o3', isSuccess: true, errorCode: null, errorText: null },
    ]);

    const result = await conn.positionManager.cancelBatchOrders({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderIdList: ['o1', 'o2', 'o3'],
    });

    expect(result).toHaveLength(3);
    expect(result.filter(item => item.isSuccess).length).toBe(2);
    expect(result.filter(item => !item.isSuccess)[0].errorCode).toBe(-2011);
  });
});

describe('PositionManager — cancelAllOrders', () => {
  it('routes to futures client for marketType=Futures', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.cancelAllOrders as jest.Mock;
    futSpy.mockClear();

    await conn.positionManager.cancelAllOrders({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
    });

    expect(futSpy).toHaveBeenCalledWith('BTCUSDT');
  });
});

describe('PositionManager — createOrder does NOT retry on 429', () => {
  it.each([ExchangeNameEnum.Bybit, ExchangeNameEnum.Binance])('does not resend an ambiguous closing IOC on %s', async exchange => {
    const connector = createConnector(exchange, PositionModeEnum.OneWay);
    const createOrder = connector.futures.createOrderWebSocket as jest.Mock;
    createOrder.mockReset();
    createOrder.mockRejectedValue(Object.assign(new Error('unknown outcome'), { response: { status: 503 } }));
    const result = await connector.positionManager.closePositionLimit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'long', amount: 1, price: 100, clientOrderId: 'durable-close-id' });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ clientOrderId: 'durable-close-id' }));
    expect(result.errorText).toBeDefined();
  });

  it('createOrder propagates 429 throw without retry (not idempotent)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futCreate = conn.futures.createOrderWebSocket as jest.Mock;
    futCreate.mockReset();
    const axiosError = Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after': '0' } } });
    futCreate.mockRejectedValue(axiosError);

    const result = await conn.positionManager.openPositionMarket({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
      amount: 1,
    });

    expect(futCreate).toHaveBeenCalledTimes(1);
    expect(result.errorText).toBeDefined();
  });
});

describe('PositionManager — modifyOrder', () => {
  it('routes to futures client for marketType=Futures', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyOrder as jest.Mock;
    const spotSpy = conn.spot.modifyOrder as jest.Mock;
    futSpy.mockClear();
    spotSpy.mockClear();

    await conn.positionManager.modifyOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: 'oid1',
      price: 105,
      amount: 2,
    });

    expect(futSpy).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 'oid1',
      price: 105,
      amount: 2,
      triggerPrice: undefined,
    });
    expect(spotSpy).not.toHaveBeenCalled();
  });

  it('routes to spot client for marketType=Spot', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyOrder as jest.Mock;
    const spotSpy = conn.spot.modifyOrder as jest.Mock;
    futSpy.mockClear();
    spotSpy.mockClear();

    await conn.positionManager.modifyOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
      orderId: 'oid2',
      price: 95,
    });

    expect(spotSpy).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 'oid2',
      price: 95,
      amount: undefined,
      triggerPrice: undefined,
    });
    expect(futSpy).not.toHaveBeenCalled();
  });

  it('passes triggerPrice when provided (for conditional orders)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyOrder as jest.Mock;
    futSpy.mockClear();

    await conn.positionManager.modifyOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: 'sl-oid',
      triggerPrice: 90,
    });

    expect(futSpy).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      orderId: 'sl-oid',
      price: undefined,
      amount: undefined,
      triggerPrice: 90,
    });
  });

  it('returns Order from client', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyOrder as jest.Mock;
    futSpy.mockReset();
    futSpy.mockResolvedValueOnce({ id: 'returnedId', symbol: 'BTCUSDT', side: OrderSideEnum.Buy });

    const result = await conn.positionManager.modifyOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: 'oid1',
      price: 101,
    });

    expect(result.id).toBe('returnedId');
  });
});

describe('PositionManager — modifyBatchOrders', () => {
  it('routes to futures client for marketType=Futures', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyBatchOrders as jest.Mock;
    const spotSpy = conn.spot.modifyBatchOrders as jest.Mock;
    futSpy.mockClear();
    spotSpy.mockClear();

    await conn.positionManager.modifyBatchOrders({
      marketType: MarketTypeEnum.Futures,
      orderList: [
        { symbol: 'BTCUSDT', orderId: 'o1', side: OrderSideEnum.Buy, price: 100 },
      ],
    });

    expect(futSpy).toHaveBeenCalledTimes(1);
    expect(spotSpy).not.toHaveBeenCalled();
  });

  it('maps PositionManagerModifyBatchOrderItem to ModifyBatchOrderArgs (all fields)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyBatchOrders as jest.Mock;
    futSpy.mockClear();

    await conn.positionManager.modifyBatchOrders({
      marketType: MarketTypeEnum.Futures,
      orderList: [
        {
          symbol: 'BTCUSDT',
          orderId: 'o1',
          side: OrderSideEnum.Buy,
          price: 100,
          amount: 0.1,
          triggerPrice: 95,
          clientOrderId: 'cid-1',
        },
        {
          symbol: 'ETHUSDT',
          orderId: 'o2',
          side: OrderSideEnum.Sell,
          price: 200,
        },
      ],
    });

    expect(futSpy).toHaveBeenCalledWith([
      {
        symbol: 'BTCUSDT',
        orderId: 'o1',
        side: OrderSideEnum.Buy,
        price: 100,
        amount: 0.1,
        triggerPrice: 95,
        clientOrderId: 'cid-1',
      },
      {
        symbol: 'ETHUSDT',
        orderId: 'o2',
        side: OrderSideEnum.Sell,
        price: 200,
        amount: undefined,
        triggerPrice: undefined,
        clientOrderId: undefined,
      },
    ]);
  });

  it('is no-op on empty orderList (returns empty array)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyBatchOrders as jest.Mock;
    futSpy.mockClear();

    const result = await conn.positionManager.modifyBatchOrders({
      marketType: MarketTypeEnum.Futures,
      orderList: [],
    });

    expect(result).toEqual([]);
    expect(futSpy).not.toHaveBeenCalled();
  });

  it('returns ModifyBatchOrdersResult from client (mixed success/error)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const futSpy = conn.futures.modifyBatchOrders as jest.Mock;
    futSpy.mockReset();
    futSpy.mockResolvedValueOnce([
      { orderId: 'o1', isSuccess: true, errorCode: null, errorText: null },
      { orderId: 'o2', isSuccess: false, errorCode: -2011, errorText: 'Unknown order sent.' },
    ]);

    const result = await conn.positionManager.modifyBatchOrders({
      marketType: MarketTypeEnum.Futures,
      orderList: [
        { symbol: 'BTCUSDT', orderId: 'o1', side: OrderSideEnum.Buy, price: 100 },
        { symbol: 'BTCUSDT', orderId: 'o2', side: OrderSideEnum.Sell, price: 105 },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.filter(item => item.isSuccess).length).toBe(1);
    expect(result.filter(item => !item.isSuccess)[0].errorCode).toBe(-2011);
  });

  it('propagates spot Not-supported error from client', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    const spotSpy = conn.spot.modifyBatchOrders as jest.Mock;
    spotSpy.mockReset();
    spotSpy.mockRejectedValueOnce(new Error('Not supported for spot market'));

    await expect(
      conn.positionManager.modifyBatchOrders({
        marketType: MarketTypeEnum.Spot,
        orderList: [{ symbol: 'BTCUSDT', orderId: 'o1', side: OrderSideEnum.Buy, price: 100 }],
      })
    ).rejects.toThrow('Not supported for spot market');
  });
});

describe('PositionManager — readPositionState', () => {
  function makeSnapshot(overrides: Partial<{ contracts: number; side: PositionSideEnum; positionIdx: number; entryPrice: number }> = {}) {
    return {
      symbol: 'BTCUSDT',
      side: PositionSideEnum.Long,
      contracts: 1,
      entryPrice: 100,
      markPrice: 100,
      unrealizedPnl: 0,
      leverage: 10,
      marginMode: MarginModeEnum.Isolated,
      liquidationPrice: 50,
      info: {},
      ...overrides,
    };
  }

  it('throws for Spot marketType', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);

    await expect(
      conn.positionManager.readPositionState({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Spot,
        direction: 'long',
      }),
    ).rejects.toThrow('readPositionState supports MarketTypeEnum.Futures only');
  });

  it('hedge mode: passes positionIdx=1 for direction=long', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const snapshotSpy = conn.futures.fetchPositionSnapshot as jest.Mock;
    snapshotSpy.mockResolvedValueOnce(makeSnapshot({ contracts: 5, side: PositionSideEnum.Long, positionIdx: 1 }));

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(snapshotSpy).toHaveBeenCalledWith('BTCUSDT', 1);
    expect(result.kind).toBe('present');
  });

  it('hedge mode: passes positionIdx=2 for direction=short', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const snapshotSpy = conn.futures.fetchPositionSnapshot as jest.Mock;
    snapshotSpy.mockResolvedValueOnce(makeSnapshot({ contracts: 3, side: PositionSideEnum.Short, positionIdx: 2 }));

    await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'short',
    });

    expect(snapshotSpy).toHaveBeenCalledWith('BTCUSDT', 2);
  });

  it('oneWay mode: passes positionIdx=undefined', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const snapshotSpy = conn.futures.fetchPositionSnapshot as jest.Mock;
    snapshotSpy.mockResolvedValueOnce(makeSnapshot({ side: PositionSideEnum.Both, contracts: 0 }));

    await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(snapshotSpy).toHaveBeenCalledWith('BTCUSDT', undefined);
  });

  it('returns absent/confirmed with reason=no_record when snapshot is null', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(null);

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('absent');
    expect(result.kind === 'absent' && result.confidence).toBe('confirmed');
    expect(result.kind === 'absent' && result.reason).toBe('no_record');
  });

  it('returns absent/confirmed with reason=zero_contracts when contracts=0 (GMTUSDT scenario)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      { ...makeSnapshot({ contracts: 0, side: PositionSideEnum.Both, positionIdx: 1 }), updatedAtMs: 1700000000000 },
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('absent');
    expect(result.kind === 'absent' && result.confidence).toBe('confirmed');
    expect(result.kind === 'absent' && result.reason).toBe('zero_contracts');
    expect(result.kind === 'absent' && result.positionUpdatedAtMs).toBe(1700000000000);
  });

  it('returns present when position has contracts and matches side', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      makeSnapshot({ contracts: 7, side: PositionSideEnum.Long, positionIdx: 1, entryPrice: 100 }),
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('present');
    expect(result.kind === 'present' && result.position.contracts).toBe(7);
  });

  it('hedge mode: returns ambiguous when positionIdx does not match', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      makeSnapshot({ contracts: 5, side: PositionSideEnum.Short, positionIdx: 2 }),
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.reason).toBe('idx_mismatch');
  });

  it('hedge mode: returns ambiguous side_mismatch when positionIdx matches but side is wrong (defence-in-depth)', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      makeSnapshot({ contracts: 5, side: PositionSideEnum.Short, positionIdx: 1 }),
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.reason).toBe('side_mismatch');
  });

  it('oneWay mode: returns ambiguous when side is opposite with contracts>0', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      makeSnapshot({ contracts: 5, side: PositionSideEnum.Short }),
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.reason).toBe('side_mismatch');
  });

  // Живой ответ демо Binance 23.11.2026: одностороннюю короткую позицию биржа отдаёт стороной
  // BOTH, направление — отдельно. Прежде вопрос «длинная?» получал «есть позиция».
  it.each([
    ['long', 'ambiguous'],
    ['short', 'present'],
  ] as const)('oneWay Binance with a short read back as side BOTH: direction=%s is %s, like Bybit', async (direction, expectedKind) => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockResolvedValueOnce(
      { ...makeSnapshot({ contracts: 103, side: PositionSideEnum.Both, positionIdx: 0, entryPrice: 0.05875 }), direction: 'short', updatedAtMs: 1795448664295 },
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'DOGEUSDT',
      marketType: MarketTypeEnum.Futures,
      direction,
    });

    expect(result.kind).toBe(expectedKind);
    expect(result.kind === 'ambiguous' && result.reason).toBe(expectedKind === 'ambiguous' ? 'side_mismatch' : false);
  });

  it('oneWay: an empty slot (side BOTH, no direction) stays a confirmed absence for either side', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionSnapshot as jest.Mock)
      .mockResolvedValueOnce({ ...makeSnapshot({ contracts: 0, side: PositionSideEnum.Both, positionIdx: 0 }), direction: null })
      .mockResolvedValueOnce({ ...makeSnapshot({ contracts: 0, side: PositionSideEnum.Both, positionIdx: 0 }), direction: null });

    const longResult = await conn.positionManager.readPositionState({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'long' });
    const shortResult = await conn.positionManager.readPositionState({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short' });

    expect(longResult.kind === 'absent' && longResult.reason).toBe('zero_contracts');
    expect(shortResult.kind === 'absent' && shortResult.reason).toBe('zero_contracts');
  });

  it('returns absent/unconfirmed with reason=fetch_error on exception', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionSnapshot as jest.Mock).mockRejectedValueOnce(new Error('network timeout'));

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('absent');
    expect(result.kind === 'absent' && result.confidence).toBe('unconfirmed');
    expect(result.kind === 'absent' && result.reason).toBe('fetch_error');
    expect(result.kind === 'absent' && result.errorText).toBe('network timeout');
  });
});

describe('PositionManager — readPositionStateByDirection (both sides of one coin in one read)', () => {
  function makePosition(overrides: Partial<{ contracts: number; side: PositionSideEnum; positionIdx: number; symbol: string; updatedAtMs: number }> = {}) {
    return {
      symbol: 'DOGEUSDT',
      side: PositionSideEnum.Both,
      direction: null,
      contracts: 0,
      entryPrice: 0,
      markPrice: 0.05884,
      unrealizedPnl: 0,
      leverage: 3,
      marginMode: MarginModeEnum.Cross,
      liquidationPrice: 0,
      positionIdx: 0,
      info: {},
      ...overrides,
    };
  }

  it('throws for Spot marketType', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);

    await expect(
      conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Spot }),
    ).rejects.toThrow('readPositionStateByDirection supports MarketTypeEnum.Futures only');
  });

  it('asks the exchange once for the one coin — never per side, never the whole account', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    const listSpy = conn.futures.fetchPositionList as jest.Mock;
    const snapshotSpy = conn.futures.fetchPositionSnapshot as jest.Mock;
    const allSpy = conn.futures.fetchAllPositions as jest.Mock;
    listSpy.mockClear();
    snapshotSpy.mockClear();
    allSpy.mockClear();
    listSpy.mockResolvedValueOnce([
      makePosition({ positionIdx: 1, side: PositionSideEnum.Long, contracts: 100 }),
      makePosition({ positionIdx: 2, side: PositionSideEnum.Short, contracts: 50 }),
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith('DOGEUSDT');
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(allSpy).not.toHaveBeenCalled();
    expect(result.long.kind === 'present' && result.long.position.contracts).toBe(100);
    expect(result.short.kind === 'present' && result.short.position.contracts).toBe(50);
  });

  it('hedge: an empty side is a confirmed absence by zero contracts, like readPositionState', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      makePosition({ positionIdx: 1, side: PositionSideEnum.Long, contracts: 0, updatedAtMs: 1700000000000 }),
      makePosition({ positionIdx: 2, side: PositionSideEnum.Short, contracts: 103 }),
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'zero_contracts', positionUpdatedAtMs: 1700000000000 });
    expect(result.short.kind).toBe('present');
  });

  it('hedge: a side missing from the answer is a confirmed absence without a record', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      makePosition({ positionIdx: 2, side: PositionSideEnum.Short, contracts: 7 }),
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'no_record' });
    expect(result.short.kind).toBe('present');
  });

  it('one-way Bybit (side "Sell"): the one entry answers for both sides by the same rules as readPositionState', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      { ...makePosition({ positionIdx: 0, side: PositionSideEnum.Short, contracts: 103 }), direction: 'short' },
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.short.kind === 'present' && result.short.position.contracts).toBe(103);
    expect(result.long.kind === 'ambiguous' && result.long.reason).toBe('side_mismatch');
  });

  // Живой ответ демо Binance 23.11.2026: одностороннюю короткую позицию биржа отдаёт стороной BOTH,
  // направление — отдельно. Без разбора по направлению длинная сторона прочиталась бы «есть».
  it('one-way Binance (side BOTH, direction short): the short side is present, the long side a side mismatch', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      { ...makePosition({ positionIdx: 0, side: PositionSideEnum.Both, contracts: 103, updatedAtMs: 1795448664295 }), direction: 'short' },
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.short.kind === 'present' && result.short.position.contracts).toBe(103);
    expect(result.long.kind === 'ambiguous' && result.long.reason).toBe('side_mismatch');
  });

  it('one-way: a coin without a position (live Bybit answer: size 0, side empty) is a confirmed absence on both sides', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([makePosition({ updatedAtMs: 1790355662609 })]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'zero_contracts', positionUpdatedAtMs: 1790355662609 });
    expect(result.short).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'zero_contracts', positionUpdatedAtMs: 1790355662609 });
  });

  it('an empty answer is a confirmed absence on both sides', async () => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'no_record' });
    expect(result.short).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'no_record' });
  });

  it('a failed read is never "no position": both sides are unconfirmed with the reason', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockRejectedValueOnce(new Error('network timeout'));

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'unconfirmed', reason: 'fetch_error', errorText: 'network timeout' });
    expect(result.short).toEqual({ kind: 'absent', confidence: 'unconfirmed', reason: 'fetch_error', errorText: 'network timeout' });
  });

  it('one-way connector but hedge entries in the answer: unconfirmed, as the per-side read refuses to pick a side', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      makePosition({ positionIdx: 1, side: PositionSideEnum.Long, contracts: 5 }),
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long.kind === 'absent' && result.long.confidence).toBe('unconfirmed');
    expect(result.short.kind === 'absent' && result.short.confidence).toBe('unconfirmed');
  });

  it('ignores entries of another coin', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
    (conn.futures.fetchPositionList as jest.Mock).mockResolvedValueOnce([
      makePosition({ symbol: 'ETHUSDT', positionIdx: 1, side: PositionSideEnum.Long, contracts: 5 }),
    ]);

    const result = await conn.positionManager.readPositionStateByDirection({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures });

    expect(result.long).toEqual({ kind: 'absent', confidence: 'confirmed', reason: 'no_record' });
  });
});

describe('PositionManager — placement answer: accepted amount and status', () => {
  type PlaceCase = [string, (conn: ExchangeConnector) => Promise<{ responseData?: { amount?: number; status?: string } }>];

  const placeCaseList: PlaceCase[] = [
    ['openPositionLimit', conn => conn.positionManager.openPositionLimit({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 103, price: 0.06765 })],
    ['openPositionMarket', conn => conn.positionManager.openPositionMarket({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 103 })],
    ['closePositionLimit', conn => conn.positionManager.closePositionLimit({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 206, price: 0.04999 })],
    ['closePositionMarket', conn => conn.positionManager.closePositionMarket({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 204 })],
    ['placeStopLoss', conn => conn.positionManager.placeStopLoss({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 206, triggerPrice: 0.07941 })],
    ['placeTakeProfit', conn => conn.positionManager.placeTakeProfit({ symbol: 'DOGEUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 206, triggerPrice: 0.05 })],
  ];

  it.each(placeCaseList)('%s: carries the amount and status the exchange answered (Binance cuts a closing order to the position)', async (_label, place) => {
    const conn = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.OneWay);
    (conn.futures.createOrderWebSocket as jest.Mock).mockResolvedValueOnce({
      id: '2395886996', symbol: 'DOGEUSDT', amount: 103, status: 'open', acceptedAmount: 103, acceptedStatus: 'open',
    });

    const result = await place(conn);

    expect(result.responseData?.amount).toBe(103);
    expect(result.responseData?.status).toBe('open');
  });

  it.each(placeCaseList)('%s: no accepted amount or status when the exchange answered with the number only (Bybit)', async (_label, place) => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.createOrderWebSocket as jest.Mock).mockResolvedValueOnce({
      id: '3c07d855-caf0-45e3-8c00-26a99429bbdd', symbol: 'DOGEUSDT', amount: 206, status: 'open',
    });

    const result = await place(conn);

    expect(result.responseData).toBeDefined();
    expect(result.responseData).not.toHaveProperty('amount');
    expect(result.responseData).not.toHaveProperty('status');
  });
});

describe('PositionManager — readAllPositions', () => {
  it('throws for Spot marketType', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);

    await expect(
      conn.positionManager.readAllPositions({ marketType: MarketTypeEnum.Spot }),
    ).rejects.toThrow('readAllPositions supports MarketTypeEnum.Futures only');
  });

  it('delegates to fetchAllPositions and returns array', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    const samplePosition = {
      symbol: 'BTCUSDT',
      side: PositionSideEnum.Long,
      direction: 'long' as const,
      contracts: 1,
      entryPrice: 100,
      markPrice: 101,
      unrealizedPnl: 0,
      leverage: 10,
      marginMode: MarginModeEnum.Isolated,
      liquidationPrice: 50,
      info: {},
    };
    (conn.futures.fetchAllPositions as jest.Mock).mockResolvedValueOnce([samplePosition]);

    const result = await conn.positionManager.readAllPositions({ marketType: MarketTypeEnum.Futures });

    expect(conn.futures.fetchAllPositions).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('BTCUSDT');
  });

  it('returns empty array when no positions', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchAllPositions as jest.Mock).mockResolvedValueOnce([]);

    const result = await conn.positionManager.readAllPositions({ marketType: MarketTypeEnum.Futures });

    expect(result).toEqual([]);
  });

  it('propagates exception from fetchAllPositions', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchAllPositions as jest.Mock).mockRejectedValueOnce(new Error('rate limit'));

    await expect(
      conn.positionManager.readAllPositions({ marketType: MarketTypeEnum.Futures }),
    ).rejects.toThrow('rate limit');
  });
});

describe('PositionManager — readOpenOrderList', () => {
  it('futures: merges plain + conditional of the one symbol asked of the exchange, dedupes by id', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchOpenOrders as jest.Mock).mockResolvedValueOnce([
      { id: 'o1', symbol: 'BTCUSDT', status: 'open' },
      { id: 'o2', symbol: 'BTCUSDT', status: 'open' },
    ]);
    (conn.futures.fetchOpenConditionalOrders as jest.Mock).mockResolvedValueOnce([
      { id: 'o2', symbol: 'BTCUSDT', status: 'open', isConditional: true },
      { id: 'o3', symbol: 'BTCUSDT', status: 'open', isConditional: true },
    ]);

    const result = await conn.positionManager.readOpenOrderList({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
    });

    expect(conn.futures.fetchOpenOrders).toHaveBeenCalledWith('BTCUSDT');
    expect(conn.futures.fetchOpenConditionalOrders).toHaveBeenCalledWith('USDT', 'BTCUSDT');
    expect(result.map(order => order.id).sort()).toEqual(['o1', 'o2', 'o3']);
  });

  it('spot: calls only fetchOpenOrders', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.spot.fetchOpenOrders as jest.Mock).mockResolvedValueOnce([
      { id: 'o1', symbol: 'BTCUSDT', status: 'open' },
    ]);

    const result = await conn.positionManager.readOpenOrderList({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Spot,
    });

    expect(result).toHaveLength(1);
    expect(conn.spot.fetchOpenConditionalOrders).not.toHaveBeenCalled();
  });

  it('rethrows on a failing fetch', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchOpenOrders as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    await expect(
      conn.positionManager.readOpenOrderList({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures }),
    ).rejects.toThrow('network error');
  });
});

describe('PositionManager — readOrder / readOrderByClientOrderId', () => {
  it('readOrder passes args through and returns the order', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.getOrder as jest.Mock).mockResolvedValueOnce({ id: 'oid-1', symbol: 'BTCUSDT', status: 'closed' });

    const result = await conn.positionManager.readOrder({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      orderId: 'oid-1',
    });

    expect(conn.futures.getOrder).toHaveBeenCalledWith('BTCUSDT', 'oid-1');
    expect(result.id).toBe('oid-1');
  });

  it('readOrder rethrows on failure', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.getOrder as jest.Mock).mockRejectedValueOnce(new Error('not found'));

    await expect(
      conn.positionManager.readOrder({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, orderId: 'oid-1' }),
    ).rejects.toThrow('not found');
  });

  it('readOrderByClientOrderId passes args through and returns the order', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.getOrderByClientOrderId as jest.Mock).mockResolvedValueOnce({ id: 'oid-2', symbol: 'BTCUSDT', status: 'open' });

    const result = await conn.positionManager.readOrderByClientOrderId({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      clientOrderId: 'cid-1',
    });

    expect(conn.futures.getOrderByClientOrderId).toHaveBeenCalledWith('BTCUSDT', 'cid-1');
    expect(result.id).toBe('oid-2');
  });

  it('readOrderByClientOrderId rethrows on failure', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.getOrderByClientOrderId as jest.Mock).mockRejectedValueOnce(new Error('not found'));

    await expect(
      conn.positionManager.readOrderByClientOrderId({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, clientOrderId: 'cid-1' }),
    ).rejects.toThrow('not found');
  });
});

describe('PositionManager — routine reads log request and response at debug', () => {
  // Called every 30 s by the entry conveyor poll, the long screen refresh and the reconcile — at info
  // they would flood the log.
  // The connector logs its stream watchdog start at info — cleared so only the read's own lines count.
  function createReadConnector(): ExchangeConnector {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    jest.mocked(logger.info).mockClear();
    jest.mocked(logger.debug).mockClear();

    return conn;
  }

  it('readOrder', async () => {
    const conn = createReadConnector();

    await conn.positionManager.readOrder({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, orderId: 'oid-1' });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('readOrder request'));
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('readOrder response'));
  });

  it('readOrderByClientOrderId', async () => {
    const conn = createReadConnector();

    await conn.positionManager.readOrderByClientOrderId({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, clientOrderId: 'cid-1' });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('readOrderByClientOrderId request'));
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('readOrderByClientOrderId response'));
  });

  it('readAllPositions', async () => {
    const conn = createReadConnector();

    await conn.positionManager.readAllPositions({ marketType: MarketTypeEnum.Futures });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('[PositionManager] readAllPositions request');
    expect(logger.debug).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('readAllPositions response'));
  });
});

describe('PositionManager — readFeeRate', () => {
  it('converts exchange fractions to percent', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchFeeRate as jest.Mock).mockResolvedValueOnce([
      { symbol: 'BTCUSDT', makerRate: 0.0002, takerRate: 0.00055 },
    ]);

    const result = await conn.positionManager.readFeeRate({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures });

    expect(result).toEqual({ makerPercent: 0.02, takerPercent: 0.055 });
  });

  it('picks the item matching the requested symbol', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchFeeRate as jest.Mock).mockResolvedValueOnce([
      { symbol: 'ETHUSDT', makerRate: 0.0001, takerRate: 0.0001 },
      { symbol: 'BTCUSDT', makerRate: 0.0002, takerRate: 0.0004 },
    ]);

    const result = await conn.positionManager.readFeeRate({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures });

    expect(result).toEqual({ makerPercent: 0.02, takerPercent: 0.04 });
  });

  it('returns null on an empty list', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchFeeRate as jest.Mock).mockResolvedValueOnce([]);

    const result = await conn.positionManager.readFeeRate({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures });

    expect(result).toBeNull();
  });

  it('returns null when the fetch throws', async () => {
    const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
    (conn.futures.fetchFeeRate as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    const result = await conn.positionManager.readFeeRate({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures });

    expect(result).toBeNull();
  });
});


describe('PositionManager isolated margin', () => {
  it.each([
    [PositionModeEnum.Hedge, 'long', PositionSideEnum.Long],
    [PositionModeEnum.Hedge, 'short', PositionSideEnum.Short],
    [PositionModeEnum.OneWay, 'long', PositionSideEnum.Both],
  ] as const)('uses position mode %s and direction %s', async (mode, direction, positionSide) => {
    const connector = createConnector(ExchangeNameEnum.Binance, mode);
    await connector.positionManager.addIsolatedPositionMargin({ symbol: 'ARBUSDT', direction, amount: 10 });
    expect(connector.futures.addIsolatedPositionMargin).toHaveBeenCalledWith({ symbol: 'ARBUSDT', positionSide, amount: 10 });
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid amount %s before sending', async (amount) => {
    const connector = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    await expect(connector.positionManager.addIsolatedPositionMargin({ symbol: 'ARBUSDT', direction: 'long', amount })).rejects.toThrow('positive');
    expect(connector.futures.addIsolatedPositionMargin).not.toHaveBeenCalled();
  });

  it('does not retry a rate limit rejection', async () => {
    const connector = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    jest.mocked(connector.futures.addIsolatedPositionMargin).mockRejectedValue(Object.assign(new Error('Too many requests'), { code: 429 }));
    await expect(connector.positionManager.addIsolatedPositionMargin({ symbol: 'ARBUSDT', direction: 'long', amount: 10 })).rejects.toThrow('Too many requests');
    expect(connector.futures.addIsolatedPositionMargin).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous failure', async () => {
    const connector = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    jest.mocked(connector.futures.addIsolatedPositionMargin).mockRejectedValue(new Error('connection lost'));
    await expect(connector.positionManager.addIsolatedPositionMargin({ symbol: 'ARBUSDT', direction: 'long', amount: 10 })).rejects.toThrow('connection lost');
    expect(connector.futures.addIsolatedPositionMargin).toHaveBeenCalledTimes(1);
  });
});


describe('queued stop-loss permission', () => {
  it.each([false, true])('checks the latest stop permission after the queue, allowed=%s', async isAllowed => {
    jest.useFakeTimers({ now: 1000 });

    try {
      const connector = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const queue = new RateLimitedRequestQueue({ rateLimit: 1, intervalMs: 1000 });
      jest.spyOn(connector, 'getWriteQueue').mockReturnValue(queue);
      const createOrder = jest.spyOn(connector, 'createOrder');
      await queue.execute(async () => undefined);
      let isCurrent = true;
      const beforeOrder = jest.fn(async () => {
        if (!isCurrent) throw new Error('stop permission changed');
      });
      const request = connector.positionManager.placeStopLoss({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 0.01, triggerPrice: 51000, beforeOrder });
      const outcome = request.then(() => 'sent', error => String(error));
      expect(beforeOrder).not.toHaveBeenCalled();
      expect(createOrder).not.toHaveBeenCalled();
      isCurrent = isAllowed;
      await jest.advanceTimersByTimeAsync(1000);
      expect(beforeOrder).toHaveBeenCalledTimes(1);

      if (isAllowed) {
        expect(await outcome).toBe('sent');
        expect(createOrder).toHaveBeenCalledTimes(1);
      } else {
        expect(await outcome).toContain('stop permission changed');
        expect(createOrder).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('beforeOrder on every order kind', () => {
  type OrderCall = (manager: ExchangeConnector['positionManager'], beforeOrder: () => Promise<void>) => Promise<unknown>;

  const caseList: [string, OrderCall][] = [
    ['placeTakeProfit', (manager, beforeOrder) => manager.placeTakeProfit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, direction: 'short', amount: 0.01, triggerPrice: 49000, beforeOrder })],
    ['openPositionBatchLimit', (manager, beforeOrder) => manager.openPositionBatchLimit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, itemList: [{ direction: 'short', amount: 0.01, price: 50000 }], beforeOrder })],
    ['closePositionBatchLimit', (manager, beforeOrder) => manager.closePositionBatchLimit({ symbol: 'BTCUSDT', marketType: MarketTypeEnum.Futures, itemList: [{ direction: 'short', amount: 0.01, price: 49000 }], beforeOrder })],
    ['spotMarketBuyByQuote', (manager, beforeOrder) => manager.spotMarketBuyByQuote({ symbol: 'BTCUSDT', quoteAmount: 10, beforeOrder })],
  ];

  function spyExchangeCalls(connector: ExchangeConnector): jest.SpyInstance[] {
    return [
      jest.spyOn(connector, 'createOrder'),
      jest.spyOn(connector, 'createBatchOrders').mockImplementation(async () => []),
    ];
  }

  it.each(caseList)('%s does not reach the exchange when beforeOrder refuses', async (_name, call) => {
    const connector = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const exchangeCallList = spyExchangeCalls(connector);

    await expect(call(connector.positionManager, async () => { throw new Error('order was superseded'); })).rejects.toThrow('order was superseded');
    expect(exchangeCallList.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it.each(caseList)('%s runs beforeOrder right before the exchange call', async (_name, call) => {
    const connector = createConnector(ExchangeNameEnum.Binance, PositionModeEnum.Hedge);
    const exchangeCallList = spyExchangeCalls(connector);
    const beforeOrder = jest.fn(async () => undefined);

    await call(connector.positionManager, beforeOrder);

    const calledList = exchangeCallList.filter(spy => spy.mock.calls.length > 0);
    expect(calledList).toHaveLength(1);
    expect(beforeOrder).toHaveBeenCalledTimes(1);
    expect(beforeOrder.mock.invocationCallOrder[0]).toBeLessThan(calledList[0].mock.invocationCallOrder[0]);
  });
});
