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

import { ExchangeConnector } from '../src/services/exchangeConnector';
import { ExchangeConfig } from '../src/types';

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
        cancelOrder: jest.fn().mockResolvedValue(undefined),
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
        setLeverage: jest.fn().mockResolvedValue(undefined),
        setMarginMode: jest.fn().mockResolvedValue(undefined),
        fetchPositionSnapshot: jest.fn().mockResolvedValue(null),
        fetchPositionList: jest.fn().mockResolvedValue([]),
        fetchAllPositions: jest.fn().mockResolvedValue([]),
      },
      spot: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT' }),
        cancelOrder: jest.fn().mockResolvedValue(undefined),
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

describe('PositionManager — setup helpers', () => {
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
      makeSnapshot({ contracts: 0, side: PositionSideEnum.Both, positionIdx: 1 }),
    );

    const result = await conn.positionManager.readPositionState({
      symbol: 'BTCUSDT',
      marketType: MarketTypeEnum.Futures,
      direction: 'long',
    });

    expect(result.kind).toBe('absent');
    expect(result.kind === 'absent' && result.confidence).toBe('confirmed');
    expect(result.kind === 'absent' && result.reason).toBe('zero_contracts');
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
