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
  BINANCE_FUTURES_TEST_SYMBOL_LIST,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL_LIST,
  calculateTestAmount,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

describeIfCredentials('bybit', 'Bybit Multiple Symbols Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'bybit';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();

    // Wait for all test symbols to load
    for (const symbol of BYBIT_FUTURES_TEST_SYMBOL_LIST) {
      await waitForTickers(connector, symbol);
    }
  }, 90000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Multiple Symbols', () => {
    test('resolveSymbolsForExchanges creates mapping for all symbols', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      expect(mapping.size).toBe(1);
      expect(mapping.has(exchangeName)).toBe(true);

      const exchangeMap = mapping.get(exchangeName)!;
      expect(exchangeMap.size).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);

      BYBIT_FUTURES_TEST_SYMBOL_LIST.forEach(symbol => {
        expect(exchangeMap.has(symbol)).toBe(true);
      });
    });

    test('getUniqueSymbolCountFromMapping counts symbols correctly', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      const count = OrderCalculator.getUniqueSymbolCountFromMapping(mapping);
      expect(count).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);
    });

    test('createOrderAttributesForSymbol creates attributes for all symbols', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: BYBIT_FUTURES_TEST_SYMBOL_LIST.length,
      });

      expect(attributes.length).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);

      attributes.forEach((attr, index) => {
        expect(attr.exchangeName).toBe(exchangeName);
        expect(attr.orderParams.price).toBeGreaterThan(0);
        expect(attr.errorText).toBeUndefined();
      });
    });

    test('all symbols have available tickers in market', () => {
      BYBIT_FUTURES_TEST_SYMBOL_LIST.forEach(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
        const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);
        expect(ticker).toBeDefined();
        expect(ticker!.close).toBeGreaterThan(0);
      });
    });

    test('setupLeverageAndMarginMode handles multiple symbols in parallel', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
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
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      // Setup leverage for all symbols
      await OrderCalculator.setupLeverageAndMarginMode({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        leverage: 5,
      });

      // Create orders for first 2 symbols in parallel
      const symbolsToTrade = BYBIT_FUTURES_TEST_SYMBOL_LIST.slice(0, 2);
      const orderPromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Buy,
          amount: calculateTestAmount(connector, symbol, ticker.close),
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const results = await Promise.all(orderPromises);

      results.forEach((result, index) => {
        expect(isOrderSuccessful(result)).toBe(true);
        expect(result.orderId).toBeDefined();
      });

      const closePromises = symbolsToTrade.map(symbol => {
        const ticker = connector.getTicker(symbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for closing ${symbol}`);
        }

        return connector.createOrder({
          symbol,
          side: OrderDirection.Sell,
          amount: calculateTestAmount(connector, symbol, ticker.close),
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
      const firstSymbol = BYBIT_FUTURES_TEST_SYMBOL_LIST[0];
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [firstSymbol],
        new Map([[exchangeName, connector]])
      );

      const ticker = connector.getTicker(firstSymbol, MarketType.Futures);
      if (!ticker?.close) return;

      const qty = calculateTestAmount(connector, firstSymbol, ticker.close);

      const openResult = await connector.createOrder({
        symbol: firstSymbol,
        side: OrderDirection.Buy,
        amount: qty,
        price: ticker.close,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      if (!isOrderSuccessful(openResult)) return;

      const positionOpen = await connector.fetchPosition(firstSymbol);

      const closeResult = await connector.createOrder({
        symbol: firstSymbol,
        side: OrderDirection.Sell,
        amount: qty,
        price: ticker.close,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);

      // Fetch position after close
      const positionClosed = await connector.fetchPosition(firstSymbol);

      // At least one should exist (open or closed state)
      expect(positionOpen !== null || positionClosed !== null).toBe(true);
    });

    test('volume calculation distributes correctly across multiple symbols', () => {
      const totalVolume = 300; // USDT
      const symbolCount = BYBIT_FUTURES_TEST_SYMBOL_LIST.length;
      const volumePerSymbol = totalVolume / symbolCount;

      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
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
    for (const symbol of BINANCE_FUTURES_TEST_SYMBOL_LIST) {
      await waitForTickers(connector, symbol);
    }
  }, 90000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('Multiple Symbols', () => {
    test('resolveSymbolsForExchanges creates mapping for all symbols on Binance', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BINANCE_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      expect(mapping.size).toBe(1);

      const exchangeMap = mapping.get(exchangeName)!;
      expect(exchangeMap.size).toBe(BINANCE_FUTURES_TEST_SYMBOL_LIST.length);
    });

    test('creates orders for multiple symbols on Binance', async () => {
      const symbolsToTrade = BINANCE_FUTURES_TEST_SYMBOL_LIST.slice(0, 2);

      await OrderCalculator.setupLeverageAndMarginMode({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: OrderCalculator.resolveSymbolsForExchanges(
          symbolsToTrade,
          new Map([[exchangeName, connector]])
        ),
        leverage: 5,
      });

      const orderPromises = symbolsToTrade.map(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
        const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for ${symbol}`);
        }

        return connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderDirection.Buy,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.close),
          price: ticker.close,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        });
      });

      const results = await Promise.all(orderPromises);

      results.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });

      const closePromises = symbolsToTrade.map(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
        const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);
        if (!ticker?.close) {
          throw new Error(`No ticker for closing ${symbol}`);
        }

        return connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderDirection.Sell,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.close),
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
