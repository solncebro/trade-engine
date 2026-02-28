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
  describeIfCredentials,
  BYBIT_DEMO_CONFIG,
  BINANCE_DEMO_CONFIG,
  FUTURES_TEST_SYMBOL,
  MIN_BTC_ORDER_QTY,
  waitForTickers,
} from './helpers/testnet.helpers';

// Test spot fallback on both exchanges
describeIfCredentials('bybit', 'Bybit Spot Fallback Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'bybit';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Spot Fallback', () => {
    test('futures ticker exists for real symbols', () => {
      const ticker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Futures);
      expect(ticker).toBeDefined();
      expect(ticker!.close).toBeGreaterThan(0);
    });

    test('returns error for non-existent symbol when calculating attributes', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['NONEXISTENT_FUTURES_PAIR_XYZ'],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      expect(attributes[0].errorText).toBeDefined();
      expect(attributes[0].errorText).toContain('No price data available');
      expect(attributes[0].orderParams.price).toBe(0);
    });

    test('enrichWithSpotFallback attempts spot market for missing futures symbol', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['NONEXISTENT_PAIR_ABC'],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      // Initial attributes should have error
      expect(attributes[0].errorText).toBeDefined();
      expect(attributes[0].orderParams.marketType).toBe(MarketType.Futures);

      // After fallback, should attempt spot market
      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      // Enriched attributes should have switched to spot or still have error (if not in spot either)
      expect(enriched[0].orderParams.marketType).toBe(MarketType.Spot);
    });

    test('creates actual spot market order when fallback succeeds', async () => {
      // Use real BTCUSDT symbol - should exist in spot
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      // Get spot ticker
      const spotTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Spot);
      if (!spotTicker?.close) {
        // Skip if spot ticker not available
        console.warn(`Spot ticker for ${FUTURES_TEST_SYMBOL} not yet loaded, skipping test`);
        return;
      }

      // Create spot order directly
      const spotOrderResult = await connector.createOrder({
        symbol: FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: MIN_BTC_ORDER_QTY,
        price: spotTicker.close,
        type: OrderType.Market,
        marketType: MarketType.Spot,
      });

      expect(isOrderSuccessful(spotOrderResult)).toBe(true);
      expect(spotOrderResult.orderId).toBeDefined();

      // Cleanup: sell to close position
      const closeResult = await connector.createOrder({
        symbol: FUTURES_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: MIN_BTC_ORDER_QTY,
        price: spotTicker.close,
        type: OrderType.Market,
        marketType: MarketType.Spot,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('spot and futures tickers are independently tracked', () => {
      const futuresTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Futures);
      const spotTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Spot);

      // Both should be available
      expect(futuresTicker).toBeDefined();
      expect(spotTicker).toBeDefined();

      // Prices may differ (spot vs futures)
      expect(futuresTicker!.close).toBeGreaterThan(0);
      expect(spotTicker!.close).toBeGreaterThan(0);
    });

    test('fallback preserves symbol through market type switch', () => {
      const symbol = 'TESTFALLBACK_SYMBOL';

      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [symbol],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      // Symbol should remain the same, only marketType should change
      expect(enriched[0].orderParams.symbol).toBe(symbol);
      expect(enriched[0].orderParams.marketType).toBe(MarketType.Spot);
    });
  });
});

describeIfCredentials('binance', 'Binance Spot Fallback Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'binance';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Spot Fallback', () => {
    test('enrichWithSpotFallback switches to spot market on futures failure', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['INVALID_SYMBOL_FOR_TESTING'],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      expect(attributes[0].orderParams.marketType).toBe(MarketType.Futures);

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      // After enrichment, marketType should be Spot
      expect(enriched[0].orderParams.marketType).toBe(MarketType.Spot);
    });

    test('creates actual spot order on Binance', async () => {
      const spotTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Spot);
      if (!spotTicker?.close) {
        console.warn(`Spot ticker for ${FUTURES_TEST_SYMBOL} not yet loaded on Binance, skipping`);
        return;
      }

      const openResult = await connector.createOrder({
        symbol: FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: MIN_BTC_ORDER_QTY,
        price: spotTicker.close,
        type: OrderType.Market,
        marketType: MarketType.Spot,
      });

      expect(isOrderSuccessful(openResult)).toBe(true);

      // Cleanup
      const closeResult = await connector.createOrder({
        symbol: FUTURES_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: MIN_BTC_ORDER_QTY,
        price: spotTicker.close,
        type: OrderType.Market,
        marketType: MarketType.Spot,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('spot ticker loading works independently from futures', () => {
      const spotTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Spot);
      const futuresTicker = connector.getTicker(FUTURES_TEST_SYMBOL, MarketType.Futures);

      // Both should be available on Binance
      expect(spotTicker).toBeDefined();
      expect(futuresTicker).toBeDefined();
      expect(spotTicker!.close).toBeGreaterThan(0);
      expect(futuresTicker!.close).toBeGreaterThan(0);
    });
  });
});
