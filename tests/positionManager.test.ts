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
  WorkingTypeEnum,
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
        cancelBatchOrders: jest.fn().mockResolvedValue(undefined),
        setLeverage: jest.fn().mockResolvedValue(undefined),
        setMarginMode: jest.fn().mockResolvedValue(undefined),
      },
      spot: {
        amountToPrecision: (_s: string, a: number) => a,
        priceToPrecision: (_s: string, p: number) => p,
        createOrderWebSocket: jest.fn().mockResolvedValue({ id: 'oid', symbol: 'BTCUSDT' }),
        cancelOrder: jest.fn().mockResolvedValue(undefined),
        cancelBatchOrders: jest.fn().mockResolvedValue(undefined),
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

    it('SL long: side=Sell, positionSide=Long, reduceOnly=true, triggerDirection=2, triggerBy=MarkPrice, closeOnTrigger=true', async () => {
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
      expect(args.triggerDirection).toBe(2);
      expect(args.triggerBy).toBe(TriggerByEnum.MarkPrice);
      expect(args.closeOnTrigger).toBe(true);
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
    });

    it('SL short: triggerDirection=1', async () => {
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
      expect(args.triggerDirection).toBe(1);
    });

    it('TP long: triggerDirection=1', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBe(1);
      expect(args.type).toBe(OrderTypeEnum.TakeProfitMarket);
    });

    it('TP short: triggerDirection=2', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.Hedge);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBe(2);
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

    it('SL long: reduceOnly=true, no positionSide, triggerDirection=2', async () => {
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
      expect(args.triggerDirection).toBe(2);
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

    it('SL short: triggerDirection=1, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeStopLoss({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBe(1);
      expect(args.reduceOnly).toBe(true);
    });

    it('TP long: triggerDirection=1, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        triggerPrice: 110,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBe(1);
      expect(args.reduceOnly).toBe(true);
    });

    it('TP short: triggerDirection=2, reduceOnly=true', async () => {
      const conn = createConnector(ExchangeNameEnum.Bybit, PositionModeEnum.OneWay);
      const result = await conn.positionManager.placeTakeProfit({
        symbol: 'BTCUSDT',
        marketType: MarketTypeEnum.Futures,
        direction: 'short',
        triggerPrice: 90,
        amount: 1,
      });
      const args = result.actualExchangeParams!;
      expect(args.triggerDirection).toBe(2);
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

    it('SL long: positionSide=LONG, NO reduceOnly, type=StopMarket, workingType=MarkPrice', async () => {
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
      expect(args.reduceOnly).toBeUndefined();
      expect(args.type).toBe(OrderTypeEnum.StopMarket);
      expect(args.workingType).toBe(WorkingTypeEnum.MarkPrice);
    });

    it('SL short: positionSide=SHORT, NO reduceOnly', async () => {
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
      expect(args.reduceOnly).toBeUndefined();
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

    it('TP long: type=TakeProfitMarket, positionSide=LONG, NO reduceOnly', async () => {
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
      expect(args.reduceOnly).toBeUndefined();
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
