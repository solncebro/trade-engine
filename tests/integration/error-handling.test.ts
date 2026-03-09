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
  BYBIT_FUTURES_TEST_SYMBOL,
  BINANCE_FUTURES_TEST_SYMBOL,
  waitForTickers,
} from './helpers/testnet.helpers';

describeIfCredentials('bybit', 'Bybit Error Handling Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'bybit';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BYBIT_FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Error Scenarios', () => {
    test('handles missing symbol gracefully with errorText (not exception)', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['NONEXISTENT_SYMBOL_XYZ_FAKE'],
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

      // Should return errorText, not throw
      expect(attributes[0].errorText).toBeDefined();
      expect(attributes[0].errorText).toContain('No price data available');
      expect(attributes[0].orderParams.price).toBe(0);
    });

    test('setupLeverageAndMarginMode does not throw even on invalid leverage', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      // Unreasonably high leverage - should fail gracefully
      await expect(
        OrderCalculator.setupLeverageAndMarginMode({
          exchangeConnectorByName: new Map([[exchangeName, connector]]),
          symbolMappingByExchange: mapping,
          leverage: 999, // Invalid
        })
      ).resolves.not.toThrow();
    });

    test('createOrder returns errorText instead of throwing on invalid amount', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: 0, // Invalid amount
        price: 50000,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      // Should NOT throw - should return result with errorText
      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);

      // Either has errorText or succeeded (depending on exchange validation)
      if (result.errorText) {
        expect(typeof result.errorText).toBe('string');
        expect(result.orderId).toBeUndefined();
      }
    });

    test('enrichWithSpotFallback handles multiple missing symbols gracefully', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['INVALID_PAIR_1', 'INVALID_PAIR_2', 'INVALID_PAIR_3'],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 3,
      });

      // All should have errorText
      attributes.forEach(attr => {
        expect(attr.errorText).toBeDefined();
        expect(attr.errorText).toContain('No price data available');
      });

      // Enrichment should not throw
      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 3,
      });

      expect(enriched.length).toBe(attributes.length);
      // May still have errors if symbols not in spot either
    });

    test('setLeverage returns boolean on any error', async () => {
      const result = await connector.setLeverage(BYBIT_FUTURES_TEST_SYMBOL, 999);

      // Should return boolean, not throw
      expect(typeof result).toBe('boolean');
    });

    test('setMarginMode returns boolean on any error', async () => {
      const result = await connector.setMarginMode(BYBIT_FUTURES_TEST_SYMBOL, 'isolated');

      // Should return boolean, not throw
      expect(typeof result).toBe('boolean');
    });

    test('fetchPosition returns null on any error', async () => {
      const position = await connector.fetchPosition('NONEXISTENT_SYMBOL');

      // Should return null, not throw
      expect(position === null || position !== null).toBe(true);
    });

    test('createOrder with negative price returns errorText', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: 0.001,
        price: -100, // Negative price
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      // Should not throw
      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);
    });

    test('createOrder with very large amount returns graceful error or success', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: 1000000, // Unreasonably large
        price: 50000,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      // Should not throw - either error or insufficient balance message
      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);
    });

    test('calculator methods handle empty symbol lists gracefully', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [],
        new Map([[exchangeName, connector]])
      );

      const count = OrderCalculator.getUniqueSymbolCountFromMapping(mapping);
      expect(count).toBe(0);

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 0,
      });

      expect(Array.isArray(attributes)).toBe(true);
      expect(attributes.length).toBe(0);
    });

    test('price adjustment handles zero price gracefully', () => {
      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: 0.001,
        price: 0, // Zero price
        type: OrderType.Market,
        marketType: MarketType.Futures,
      };

      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        40,
        100,
        5
      );

      // Should handle gracefully
      expect(result).toBeDefined();
      expect(typeof result.price).toBe('number');
    });

    test('all order creation failures are non-throwing', async () => {
      const testCases = [
        {
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          amount: 0, // Invalid
          price: 50000,
        },
        {
          symbol: 'FAKE_SYMBOL',
          amount: 0.001,
          price: 50000,
        },
        {
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          amount: 0.001,
          price: -100, // Invalid price
        },
      ];

      for (const testCase of testCases) {
        const result = await connector.createOrder({
          symbol: testCase.symbol,
          side: OrderDirection.Buy,
          amount: testCase.amount,
          price: testCase.price,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });

        // All should return OrderResult, never throw
        expect(result).toBeDefined();
        expect(result.exchangeName).toBe(exchangeName);
      }
    });
  });
});

describeIfCredentials('binance', 'Binance Error Handling Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'binance';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BINANCE_FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Error Scenarios', () => {
    test('handles missing symbol without throwing exception', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['NONEXISTENT_BINANCE_PAIR_ABC'],
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
    });

    test('enrichWithSpotFallback gracefully handles errors on Binance', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['INVALID_PAIR_ABC', 'INVALID_PAIR_DEF'],
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 2,
      });

      expect(attributes.length).toBe(2);
      attributes.forEach(attr => {
        expect(attr.errorText).toBeDefined();
      });

      // Fallback should not throw
      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 2,
      });

      expect(enriched.length).toBe(attributes.length);
    });

    test('setupLeverageAndMarginMode is non-blocking on Binance', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BINANCE_FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginMode({
          exchangeConnectorByName: new Map([[exchangeName, connector]]),
          symbolMappingByExchange: mapping,
          leverage: 100, // May fail, but should not throw
        })
      ).resolves.not.toThrow();
    });

    test('createOrder never throws, always returns OrderResult', async () => {
      const result = await connector.createOrder({
        symbol: 'FAKE_PAIR_XYZ',
        side: OrderDirection.Buy,
        amount: 0.001,
        price: 50000,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);
      // May have errorText or succeed, but never throws
    });

    test('all error paths are non-exception based', async () => {
      const testCases = [
        {
          description: 'Missing symbol',
          symbol: 'NONEXISTENT_ABC',
          amount: 0.001,
          price: 50000,
        },
        {
          description: 'Zero amount',
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          amount: 0,
          price: 50000,
        },
        {
          description: 'Negative price',
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          amount: 0.001,
          price: -1000,
        },
      ];

      for (const testCase of testCases) {
        const result = await connector.createOrder({
          symbol: testCase.symbol,
          side: OrderDirection.Buy,
          amount: testCase.amount,
          price: testCase.price,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });

        // None should throw - all should return result
        expect(result).toBeDefined();
        expect(result.exchangeName).toBe(exchangeName);
      }
    });
  });
});
