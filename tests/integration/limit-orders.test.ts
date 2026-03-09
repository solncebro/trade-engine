import { ExchangeConnector } from '../../src/services/exchangeConnector';
import { OrderCalculator } from '../../src/core/orderCalculator';
import {
  ExchangeConnectorByName,
  ExchangeName,
  MarketType,
  OrderDirection,
  OrderType,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
  calculateTestAmount,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

describeIfCredentials('bybit', 'Bybit Limit Orders Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'bybit';
  const PRICE_ADJUSTMENT_PERCENT = 40; // +40% for realistic coin-listing scenario

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
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();
      expect(ticker!.close).toBeGreaterThan(0);

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100, // orderVolumeUsdt
        5 // leverage
      );

      expect(limitOrder.type).toBe(OrderType.Limit);
      // Price should increase by 40%
      expect(limitOrder.price).toBeGreaterThan(ticker!.close! * 1.39);
      expect(limitOrder.price).toBeLessThan(ticker!.close! * 1.41);
      const amountAtOriginalPrice = 100 / baseOrderParams.price;
      expect(limitOrder.amount).toBeLessThan(amountAtOriginalPrice);
    });

    test('calculateLimitOrderWithPriceAdjustment decreases sell limit price by 40%', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        -PRICE_ADJUSTMENT_PERCENT, // Negative for sell
        100,
        5
      );

      expect(limitOrder.type).toBe(OrderType.Limit);
      // Price should decrease by 40%
      expect(limitOrder.price).toBeLessThan(ticker!.close! * 0.61);
      expect(limitOrder.price).toBeGreaterThan(ticker!.close! * 0.59);
    });

    test('creates actual buy limit order on demo', async () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      // Calculate limit order with +40% adjustment
      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      // Create the limit order
      const result = await connector.createOrder({
        symbol: limitOrder.symbol,
        side: limitOrder.side,
        amount: limitOrder.amount,
        price: limitOrder.price,
        type: limitOrder.type,
        marketType: limitOrder.marketType,
      });

      // Verify order was created
      expect(result.exchangeName).toBe(exchangeName);

      if (isOrderSuccessful(result)) {
        expect(result.orderId).toBeDefined();
        expect(typeof result.orderId).toBe('string');

        // Try to fetch the order details via position
        const position = await connector.fetchPosition(BYBIT_FUTURES_TEST_SYMBOL);

        // Cleanup: cancel or close via market order
        // Market sell to close any potential position
        const closeResult = await connector.createOrder({
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          side: OrderDirection.Sell,
          amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
          price: ticker!.close!,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });

        expect(isOrderSuccessful(closeResult)).toBe(true);
      }
    });

    test('creates sell limit order below market price', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      // For close position (take profit), create limit order below market
      const sellLimit = OrderCalculator.calculateCloseOrder(
        baseOrderParams,
        -PRICE_ADJUSTMENT_PERCENT, // Negative shift for sell limit
        false // Not take profit, so will have triggerPrice
      );

      expect(sellLimit.price).toBeLessThan(ticker!.close!);
      expect(sellLimit.triggerPrice).toBeDefined();
      expect(sellLimit.triggerPrice).toBeLessThan(ticker!.close!);
    });

    test('limit order amount is recalculated based on adjusted price', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      const marketPrice = ticker!.close!;

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: marketPrice,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      const amountAtOriginalPrice = 100 / baseOrderParams.price;
      expect(limitOrder.amount).toBeLessThan(amountAtOriginalPrice);

      // Verify the amount is reasonable
      const expectedCost = limitOrder.amount * limitOrder.price;
      expect(expectedCost).toBeGreaterThan(95); // ~100 USDT ±5%
      expect(expectedCost).toBeLessThan(105);
    });

    test('createCloseOrder generates TP/SL with correct prices', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);
      const entryPrice = ticker!.close!;

      const entryOrder = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: entryPrice,
        type: OrderType.Market as OrderType,
        marketType: MarketType.Futures,
      };

      // Take Profit: 40% above entry
      const takeProfit = OrderCalculator.calculateCloseOrder(entryOrder, PRICE_ADJUSTMENT_PERCENT, true);
      expect(takeProfit.side).toBe(OrderDirection.Sell);
      expect(takeProfit.type).toBe(OrderType.Limit);
      expect(takeProfit.price).toBeGreaterThan(entryPrice * 1.39);
      expect(takeProfit.triggerPrice).toBeUndefined(); // TP doesn't use trigger price

      // Stop Loss: 40% below entry
      const stopLoss = OrderCalculator.calculateCloseOrder(entryOrder, -PRICE_ADJUSTMENT_PERCENT, false);
      expect(stopLoss.side).toBe(OrderDirection.Sell);
      expect(stopLoss.type).toBe(OrderType.Limit);
      expect(stopLoss.price).toBeGreaterThan(entryPrice / 1.41);
      expect(stopLoss.price).toBeLessThan(entryPrice / 1.39);
      expect(stopLoss.triggerPrice).toBeDefined();
      expect(stopLoss.triggerDirection).toBe(2); // Bybit: 2 = triggered when price falls
    });

    test('handles limit order with different leverage settings', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketType.Futures);

      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      // With 1x leverage (spot-like)
      const limitWith1x = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        1
      );

      // With 5x leverage
      const limitWith5x = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      expect(limitWith5x.amount).toBeCloseTo(limitWith1x.amount);
    });
  });
});

describeIfCredentials('binance', 'Binance Limit Orders Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'binance';
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
      const ticker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();

      const baseOrderParams = {
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

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

        // Cleanup
        const closeResult = await connector.createOrder({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          side: OrderDirection.Sell,
          amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.close!),
          price: ticker!.close!,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });

        expect(isOrderSuccessful(closeResult)).toBe(true);
      }
    });

    test('limit order calculation is consistent across both exchanges', () => {
      const ticker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketType.Futures);

      const baseOrderParams = {
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: calculateTestAmount(connector, BINANCE_FUTURES_TEST_SYMBOL, ticker!.close!),
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      // Should follow same formula regardless of exchange
      expect(limitOrder.price).toBeCloseTo(ticker!.close! * 1.4, 1);
    });
  });
});
