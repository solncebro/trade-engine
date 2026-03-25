import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
  calculateTestAmount,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

import { OrderCalculator } from '../../src/core/orderCalculator';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeNameEnum,
  MarketTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit Limit Orders Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Bybit;
  const PRICE_ADJUSTMENT_PERCENT = 40;

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BYBIT_FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Limit Orders', () => {
    test('calculateLimitOrderWithPriceAdjustment increases buy limit price by 40%', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();
      expect(ticker!.lastPrice).toBeGreaterThan(0);

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      expect(limitOrder.type).toBe(OrderTypeEnum.Limit);
      expect(limitOrder.price).toBeGreaterThan(ticker!.lastPrice! * 1.39);
      expect(limitOrder.price).toBeLessThan(ticker!.lastPrice! * 1.41);
      const amountAtOriginalPrice = 100 / baseOrderParams.price;
      expect(limitOrder.amount).toBeLessThan(amountAtOriginalPrice);
    });

    test('calculateLimitOrderWithPriceAdjustment decreases sell limit price by 40%', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: -PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      expect(limitOrder.type).toBe(OrderTypeEnum.Limit);
      expect(limitOrder.price).toBeLessThan(ticker!.lastPrice! * 0.61);
      expect(limitOrder.price).toBeGreaterThan(ticker!.lastPrice! * 0.59);
    });

    test('creates actual buy limit order on demo', async () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      const result = await connector.createOrder({
        symbol: limitOrder.symbol,
        side: limitOrder.side,
        amount: limitOrder.amount,
        price: limitOrder.price,
        type: limitOrder.type,
        marketType: limitOrder.marketType,
      });

      expect(result.exchangeName).toBe(exchangeName);

      if (isOrderSuccessful(result)) {
        expect(result.orderId).toBeDefined();
        expect(typeof result.orderId).toBe('string');

        await connector.futures.fetchPosition(BYBIT_FUTURES_TEST_SYMBOL);

        const closeResult = await connector.createOrder({
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          side: OrderSideEnum.Sell,
          amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
          price: ticker!.lastPrice!,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        expect(isOrderSuccessful(closeResult)).toBe(true);
      }
    });

    test('creates sell limit order below market price', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const sellLimit = OrderCalculator.calculateCloseOrder(
        baseOrderParams,
        -PRICE_ADJUSTMENT_PERCENT,
        false
      );

      expect(sellLimit.price).toBeLessThan(ticker!.lastPrice!);
      expect(sellLimit.triggerPrice).toBeDefined();
      expect(sellLimit.triggerPrice).toBeLessThan(ticker!.lastPrice!);
    });

    test('limit order amount is recalculated based on adjusted price', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      const marketPrice = ticker!.lastPrice!;

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: marketPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      const amountAtOriginalPrice = 100 / baseOrderParams.price;
      expect(limitOrder.amount).toBeLessThan(amountAtOriginalPrice);

      const expectedCost = limitOrder.amount * limitOrder.price;
      expect(expectedCost).toBeGreaterThan(95);
      expect(expectedCost).toBeLessThan(105);
    });

    test('createCloseOrder generates TP/SL with correct prices', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      const entryPrice = ticker!.lastPrice!;

      const entryOrder = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: entryPrice,
        type: OrderTypeEnum.Market as OrderTypeEnum,
        marketType: MarketTypeEnum.Futures,
      };

      const takeProfit = OrderCalculator.calculateCloseOrder(entryOrder, PRICE_ADJUSTMENT_PERCENT, true);
      expect(takeProfit.side).toBe(OrderSideEnum.Sell);
      expect(takeProfit.type).toBe(OrderTypeEnum.Limit);
      expect(takeProfit.price).toBeGreaterThan(entryPrice * 1.39);
      expect(takeProfit.triggerPrice).toBeUndefined();

      const stopLoss = OrderCalculator.calculateCloseOrder(entryOrder, -PRICE_ADJUSTMENT_PERCENT, false);
      expect(stopLoss.side).toBe(OrderSideEnum.Sell);
      expect(stopLoss.type).toBe(OrderTypeEnum.Limit);
      expect(stopLoss.price).toBeGreaterThan(entryPrice / 1.41);
      expect(stopLoss.price).toBeLessThan(entryPrice / 1.39);
      expect(stopLoss.triggerPrice).toBeDefined();
      expect(stopLoss.triggerDirection).toBe(2);
    });

    test('handles limit order with different leverage settings', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitWith1x = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 1,
      });

      const limitWith5x = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      expect(limitWith5x.amount).toBeCloseTo(limitWith1x.amount);
    });
  });
});

describeIfCredentials(ExchangeNameEnum.Binance, 'Binance Limit Orders Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Binance;
  const PRICE_ADJUSTMENT_PERCENT = 40;

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BINANCE_FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Limit Orders', () => {
    test('creates limit order on Binance with 40% price adjustment', async () => {
      const ticker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      const result = await connector.createOrder({
        symbol: limitOrder.symbol,
        side: limitOrder.side,
        amount: limitOrder.amount,
        price: limitOrder.price,
        type: limitOrder.type,
        marketType: limitOrder.marketType,
      });

      expect(result.exchangeName).toBe(exchangeName);

      if (isOrderSuccessful(result)) {
        expect(result.orderId).toBeDefined();

        const closeResult = await connector.createOrder({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          side: OrderSideEnum.Sell,
          amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
          price: ticker!.lastPrice!,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        expect(isOrderSuccessful(closeResult)).toBe(true);
      }
    });

    test('limit order calculation is consistent across both exchanges', () => {
      const ticker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);

      const baseOrderParams = {
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.lastPrice!),
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: baseOrderParams,
        priceAdjustmentPercent: PRICE_ADJUSTMENT_PERCENT,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      expect(limitOrder.price).toBeCloseTo(ticker!.lastPrice! * 1.4, 1);
    });
  });
});
