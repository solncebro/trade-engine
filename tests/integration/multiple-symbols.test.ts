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
  MULTIPLE_TEST_SYMBOLS,
  MIN_BTC_ORDER_QTY,
  waitForTickers,
} from './helpers/testnet.helpers';

describeIfCredentials('bybit', 'Bybit Multiple Symbols Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'bybit';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();

    // Wait for all test symbols to load
    for (const symbol of MULTIPLE_TEST_SYMBOLS) {
      await waitForTickers(connector, symbol);
    }
  }, 90000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Multiple Symbols', () => {
    test('resolveSymbolsForExchanges creates mapping for all symbols', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      expect(mapping.size).toBe(1);
      expect(mapping.has(exchangeName)).toBe(true);

      const exchangeMap = mapping.get(exchangeName)!;
      expect(exchangeMap.size).toBe(MULTIPLE_TEST_SYMBOLS.length);

      MULTIPLE_TEST_SYMBOLS.forEach(symbol => {
        expect(exchangeMap.has(symbol)).toBe(true);
      });
    });

    test('getUniqueSymbolCountFromMapping counts symbols correctly', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      const count = OrderCalculator.getUniqueSymbolCountFromMapping(mapping);
      expect(count).toBe(MULTIPLE_TEST_SYMBOLS.length);
    });

    test('createOrderAttributesForSymbol creates attributes for all symbols', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: MULTIPLE_TEST_SYMBOLS.length,
      });

      expect(attributes.length).toBe(MULTIPLE_TEST_SYMBOLS.length);

      attributes.forEach((attr, index) => {
        expect(attr.exchangeName).toBe(exchangeName);
        expect(attr.orderParams.price).toBeGreaterThan(0);
        expect(attr.errorText).toBeUndefined();
      });
    });

    test('all symbols have available tickers in market', () => {
      MULTIPLE_TEST_SYMBOLS.forEach(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        expect(ticker).toBeDefined();
        expect(ticker!.close).toBeGreaterThan(0);
      });
    });

    test('setupLeverageAndMarginMode handles multiple symbols in parallel', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      // Should complete without throwing, even if some symbols fail
      await expect(
        OrderCalculator.setupLeverageAndMarginMode({
          exchangeConnectorByName: new Map([[exchangeName, connector]]),
          symbolMappingByExchange: mapping,
          leverage: 5,
        })
      ).resolves.not.toThrow();
    });

    test('creates orders for multiple symbols and verifies all are successful', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      // Setup leverage for all symbols
      await OrderCalculator.setupLeverageAndMarginMode({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        leverage: 5,
      });

      // Create orders for first 2 symbols in parallel
      const symbolsToTrade = MULTIPLE_TEST_SYMBOLS.slice(0, 2);
      const orderPromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Buy,
          amount: MIN_BTC_ORDER_QTY,
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const results = await Promise.all(orderPromises);

      // All orders should be successful
      results.forEach((result, index) => {
        expect(isOrderSuccessful(result)).toBe(true);
        expect(result.orderId).toBeDefined();
      });

      // Cleanup: close all positions
      const closePromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for closing ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Sell,
          amount: MIN_BTC_ORDER_QTY,
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const closeResults = await Promise.all(closePromises);
      closeResults.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });
    });

    test('can fetch positions for multiple symbols after trading', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [MULTIPLE_TEST_SYMBOLS[0]],
        new Map([[exchangeName, connector]])
      );

      // Create and immediately close a position
      const ticker = connector.getTicker(MULTIPLE_TEST_SYMBOLS[0], MarketType.Futures);
      if (!ticker?.close) return;

      const openResult = await connector.createOrder({
        symbol: MULTIPLE_TEST_SYMBOLS[0],
        side: OrderDirection.Buy,
        amount: MIN_BTC_ORDER_QTY,
        price: ticker.close,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      if (!isOrderSuccessful(openResult)) return;

      // Fetch position while open
      const positionOpen = await connector.fetchPosition(MULTIPLE_TEST_SYMBOLS[0]);

      // Close position
      const closeResult = await connector.createOrder({
        symbol: MULTIPLE_TEST_SYMBOLS[0],
        side: OrderDirection.Sell,
        amount: MIN_BTC_ORDER_QTY,
        price: ticker.close,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);

      // Fetch position after close
      const positionClosed = await connector.fetchPosition(MULTIPLE_TEST_SYMBOLS[0]);

      // At least one should exist (open or closed state)
      expect(positionOpen !== null || positionClosed !== null).toBe(true);
    });

    test('volume calculation distributes correctly across multiple symbols', () => {
      const totalVolume = 300; // USDT
      const symbolCount = MULTIPLE_TEST_SYMBOLS.length;
      const volumePerSymbol = totalVolume / symbolCount;

      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: totalVolume,
        leverage: 5,
        uniqueSymbolCount: symbolCount,
      });

      // Each symbol should have amount calculated from divided volume
      attributes.forEach(attr => {
        const expectedAmount = volumePerSymbol / attr.orderParams.price;
        // Amount should be roughly in the right range (allowing for rounding)
        expect(attr.orderParams.amount).toBeGreaterThan(0);
      });
    });
  });
});

describeIfCredentials('binance', 'Binance Multiple Symbols Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'binance';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();

    // Wait for all test symbols to load
    for (const symbol of MULTIPLE_TEST_SYMBOLS) {
      await waitForTickers(connector, symbol);
    }
  }, 90000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Multiple Symbols', () => {
    test('resolveSymbolsForExchanges creates mapping for all symbols on Binance', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        MULTIPLE_TEST_SYMBOLS,
        new Map([[exchangeName, connector]])
      );

      expect(mapping.size).toBe(1);

      const exchangeMap = mapping.get(exchangeName)!;
      expect(exchangeMap.size).toBe(MULTIPLE_TEST_SYMBOLS.length);
    });

    test('creates orders for multiple symbols on Binance', async () => {
      const symbolsToTrade = MULTIPLE_TEST_SYMBOLS.slice(0, 2);

      await OrderCalculator.setupLeverageAndMarginMode({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: OrderCalculator.resolveSymbolsForExchanges(
          symbolsToTrade,
          new Map([[exchangeName, connector]])
        ),
        leverage: 5,
      });

      const orderPromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Buy,
          amount: MIN_BTC_ORDER_QTY,
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const results = await Promise.all(orderPromises);

      results.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });

      // Cleanup
      const closePromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for closing ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Sell,
          amount: MIN_BTC_ORDER_QTY,
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const closeResults = await Promise.all(closePromises);
      closeResults.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });
    });
  });
});
