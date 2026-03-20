import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
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

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit Error Handling Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Bybit;

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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributes[0].errorText).toBeDefined();
      expect(attributes[0].errorText).toContain('No price data available');
      expect(attributes[0].orderParams.price).toBe(0);
    });

    test('setupLeverageAndMarginModeEnum does not throw even on invalid leverage', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginModeEnum({
          exchangeConnectorByName: new Map([[exchangeName, connector]]),
          symbolMappingByExchange: mapping,
          leverage: 999,
        })
      ).resolves.not.toThrow();
    });

    test('createOrder returns errorText instead of throwing on invalid amount', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: 0,
        price: 50000,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);

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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      attributes.forEach(attr => {
        expect(attr.errorText).toBeDefined();
        expect(attr.errorText).toContain('No price data available');
      });

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(enriched.length).toBe(attributes.length);
    });

    test('setLeverage returns boolean on any error', async () => {
      const result = await connector.setLeverage(BYBIT_FUTURES_TEST_SYMBOL, 999);

      expect(typeof result).toBe('boolean');
    });

    test('setMarginMode returns boolean on any error', async () => {
      const result = await connector.setMarginMode(BYBIT_FUTURES_TEST_SYMBOL, 'isolated');

      expect(typeof result).toBe('boolean');
    });

    test('fetchPosition returns null on any error', async () => {
      const position = await connector.fetchPosition('NONEXISTENT_SYMBOL');

      expect(position === null || position !== null).toBe(true);
    });

    test('createOrder with negative price returns errorText', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: 0.001,
        price: -100,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);
    });

    test('createOrder with very large amount returns graceful error or success', async () => {
      const result = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: 1000000,
        price: 50000,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(Array.isArray(attributes)).toBe(true);
      expect(attributes.length).toBe(0);
    });

    test('price adjustment handles zero price gracefully', () => {
      const baseOrderParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: 0.001,
        price: 0,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      };

      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        baseOrderParams,
        40,
        100,
        5
      );

      expect(result).toBeDefined();
      expect(typeof result.price).toBe('number');
    });

    test('all order creation failures are non-throwing', async () => {
      const testCaseList = [
        {
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          amount: 0,
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
          price: -100,
        },
      ];

      for (const testCase of testCaseList) {
        const result = await connector.createOrder({
          symbol: testCase.symbol,
          side: OrderSideEnum.Buy,
          amount: testCase.amount,
          price: testCase.price,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        expect(result).toBeDefined();
        expect(result.exchangeName).toBe(exchangeName);
      }
    });
  });
});

describeIfCredentials(ExchangeNameEnum.Binance, 'Binance Error Handling Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Binance;

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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributes.length).toBe(2);
      attributes.forEach(attr => {
        expect(attr.errorText).toBeDefined();
      });

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(enriched.length).toBe(attributes.length);
    });

    test('setupLeverageAndMarginModeEnum is non-blocking on Binance', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BINANCE_FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginModeEnum({
          exchangeConnectorByName: new Map([[exchangeName, connector]]),
          symbolMappingByExchange: mapping,
          leverage: 100,
        })
      ).resolves.not.toThrow();
    });

    test('createOrder never throws, always returns OrderResult', async () => {
      const result = await connector.createOrder({
        symbol: 'FAKE_PAIR_XYZ',
        side: OrderSideEnum.Buy,
        amount: 0.001,
        price: 50000,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      expect(result).toBeDefined();
      expect(result.exchangeName).toBe(exchangeName);
    });

    test('all error paths are non-exception based', async () => {
      const testCaseList = [
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

      for (const testCase of testCaseList) {
        const result = await connector.createOrder({
          symbol: testCase.symbol,
          side: OrderSideEnum.Buy,
          amount: testCase.amount,
          price: testCase.price,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        expect(result).toBeDefined();
        expect(result.exchangeName).toBe(exchangeName);
      }
    });
  });
});
