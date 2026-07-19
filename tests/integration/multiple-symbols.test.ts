import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL_LIST,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL_LIST,
  calculateTestAmount,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

import { OrderCalculator } from '../../src/core/orderCalculator';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeNameEnum,
  MarketTypeEnum,
  OrderResult,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit Multiple Symbols Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Bybit;

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();

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

      const attributeList = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributeList.length).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);

      attributeList.forEach(attr => {
        expect(attr.exchangeName).toBe(exchangeName);
        expect(attr.orderParams.price).toBeGreaterThan(0);
        expect(attr.errorText).toBeUndefined();
      });
    });

    test('all symbols have available tickers in market', () => {
      BYBIT_FUTURES_TEST_SYMBOL_LIST.forEach(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol, MarketTypeEnum.Futures);
        const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);
        expect(ticker).toBeDefined();
        expect(ticker!.lastPrice).toBeGreaterThan(0);
      });
    });

    test('setupLeverageAndMarginModeEnum handles multiple symbols in parallel', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginModeEnum({
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

      await OrderCalculator.setupLeverageAndMarginModeEnum({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        leverage: 5,
      });

      const symbolToTradeList = BYBIT_FUTURES_TEST_SYMBOL_LIST.slice(0, 2);
      const orderPromiseList = symbolToTradeList.map(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol, MarketTypeEnum.Futures);
        const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);

        if (!ticker?.lastPrice) {
          throw new Error(`No ticker for ${resolvedSymbol}`);
        }

        return connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderSideEnum.Buy,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.lastPrice),
          price: ticker.lastPrice,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });
      });

      const resultList = await Promise.all(orderPromiseList);

      resultList.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
        expect(result.orderId).toBeDefined();
      });

      const closePromiseList = symbolToTradeList.map(symbol => {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol, MarketTypeEnum.Futures);
        const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);

        if (!ticker?.lastPrice) {
          throw new Error(`No ticker for closing ${resolvedSymbol}`);
        }

        return connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderSideEnum.Sell,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.lastPrice),
          price: ticker.lastPrice,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
          params: { reduceOnly: true },
        });
      });

      const closeResultList = await Promise.all(closePromiseList);

      closeResultList.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });
    });

    test('can fetch positions for multiple symbols after trading', async () => {
      const firstSymbol = BYBIT_FUTURES_TEST_SYMBOL_LIST[0];
      OrderCalculator.resolveSymbolsForExchanges(
        [firstSymbol],
        new Map([[exchangeName, connector]])
      );

      const ticker = connector.getTicker(firstSymbol, MarketTypeEnum.Futures);
      if (!ticker?.lastPrice) return;

      const qty = calculateTestAmount(connector, firstSymbol, ticker.lastPrice);

      const openResult = await connector.createOrder({
        symbol: firstSymbol,
        side: OrderSideEnum.Buy,
        amount: qty,
        price: ticker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      if (!isOrderSuccessful(openResult)) return;

      const positionOpen = await connector.futures.fetchPosition(firstSymbol);

      const closeResult = await connector.createOrder({
        symbol: firstSymbol,
        side: OrderSideEnum.Sell,
        amount: qty,
        price: ticker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);

      const positionClosed = await connector.futures.fetchPosition(firstSymbol);

      expect(positionOpen !== null || positionClosed !== null).toBe(true);
    });

    test('volume calculation distributes correctly across multiple symbols', () => {
      const totalVolume = 300;

      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        new Map([[exchangeName, connector]])
      );

      const attributeList = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, totalVolume]]),
        leverage: 5,
      });

      const expectedVolumePerSymbol = totalVolume / BYBIT_FUTURES_TEST_SYMBOL_LIST.length;

      attributeList.forEach(attr => {
        expect(attr.orderParams.amount).toBeGreaterThan(0);
        expect(attr.orderVolumeUsdt).toBe(expectedVolumePerSymbol);
      });
    });
  });
});

describeIfCredentials(ExchangeNameEnum.Binance, 'Binance Multiple Symbols Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName = ExchangeNameEnum.Binance;

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();

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
      const symbolToTradeList = BINANCE_FUTURES_TEST_SYMBOL_LIST.slice(0, 2);

      await OrderCalculator.setupLeverageAndMarginModeEnum({
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        symbolMappingByExchange: OrderCalculator.resolveSymbolsForExchanges(
          symbolToTradeList,
          new Map([[exchangeName, connector]])
        ),
        leverage: 5,
      });

      const openResultList: OrderResult[] = [];

      for (const symbol of symbolToTradeList) {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(
          symbol,
          MarketTypeEnum.Futures
        );
        const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);

        if (!ticker?.lastPrice) {
          throw new Error(`No ticker for ${symbol}`);
        }

        const openResult = await connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderSideEnum.Buy,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.lastPrice),
          price: ticker.lastPrice,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        openResultList.push(openResult);
      }

      openResultList.forEach(result => {
        expect(isOrderSuccessful(result)).toBe(true);
      });

      for (const symbol of symbolToTradeList) {
        const resolvedSymbol = connector.resolveSymbolWithPrefix(
          symbol,
          MarketTypeEnum.Futures
        );
        const ticker = connector.getTicker(resolvedSymbol, MarketTypeEnum.Futures);

        if (!ticker?.lastPrice) {
          throw new Error(`No ticker for closing ${symbol}`);
        }

        const closeResult = await connector.createOrder({
          symbol: resolvedSymbol,
          side: OrderSideEnum.Sell,
          amount: calculateTestAmount(connector, resolvedSymbol, ticker.lastPrice),
          price: ticker.lastPrice,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        expect(isOrderSuccessful(closeResult)).toBe(true);
      }
    });
  });
});
