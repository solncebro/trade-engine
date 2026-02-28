import {
  BINANCE_DEMO_CONFIG,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

import { logger } from '../../src/core/logger';
import { OrderCalculator } from '../../src/core/orderCalculator';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeConnectorByName,
  ExchangeName,
  MarketType,
  OrderDirection,
  OrderType,
  SymbolMappingByExchange,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

const BINANCE_TEST_SYMBOL = 'ETHUSDT';
const MIN_ORDER_QTY = 0.1;
const LIMIT_PRICE_ADJUSTMENT_PERCENT = 5;

const TEST_SYMBOLS = [
  BINANCE_TEST_SYMBOL,
  '1000FLOKIUSDT',
  '1000SHIBUSDT',
];

const serializeMapping = (
  mapping: SymbolMappingByExchange
): Record<string, Record<string, string>> => {
  const result: Record<string, Record<string, string>> = {};

  for (const [exchange, symbolMap] of mapping) {
    result[exchange] = Object.fromEntries(symbolMap);
  }

  return result;
};

describeIfCredentials('binance', 'Binance Demo Integration', () => {
  let connector: ExchangeConnector;
  const exchangeName: ExchangeName = 'binance';

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BINANCE_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('ExchangeConnector', () => {
    test('getExchangeName() returns binance', () => {
      const result = connector.getExchangeName();
      logger.info({ result }, 'getExchangeName test result');
      expect(result).toBe('binance');
    });

    test('getAccountId() returns a 16-char hash string', () => {
      const accountId = connector.getAccountId();
      logger.info({ accountId }, 'getAccountId test result');
      expect(accountId).toMatch(/^[a-f0-9]{16}$/);
    });

    test('getFuturesSymbols() returns non-empty list with ETH', async () => {
      const symbols = await connector.getFuturesSymbols();
      logger.info(
        { count: symbols.length, sample: [...symbols].sort().slice(0, 20) },
        'getFuturesSymbols test result'
      );
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols).toEqual(
        expect.arrayContaining([expect.stringContaining('ETH')])
      );
    });

    test('getSpotSymbols() returns non-empty list', async () => {
      const symbols = await connector.getSpotSymbols();
      logger.info(
        { count: symbols.length, sample: [...symbols].sort().slice(0, 20) },
        'getSpotSymbols test result'
      );
      expect(symbols.length).toBeGreaterThan(0);
    });

    test('getTicker() returns price data for futures', () => {
      const ticker = connector.getTicker(
        BINANCE_TEST_SYMBOL,
        MarketType.Futures
      );
      logger.info({ ticker }, 'getTicker test result');
      expect(ticker).toBeDefined();
      expect(ticker!.close).toBeGreaterThan(0);
    });

    test('resolveSymbolWithPrefix() resolves all test symbols', () => {
      const resolved: Record<string, string> = {};

      for (const symbol of TEST_SYMBOLS) {
        resolved[symbol] = connector.resolveSymbolWithPrefix(symbol);
      }

      logger.info({ resolved }, 'resolveSymbolWithPrefix test result');

      for (const symbol of TEST_SYMBOLS) {
        expect(resolved[symbol]).toBe(symbol);
      }
    });

    test('setLeverage() completes without throwing', async () => {
      const isSuccess = await connector.setLeverage(BINANCE_TEST_SYMBOL, 5);
      logger.info(
        { symbol: BINANCE_TEST_SYMBOL, leverage: 5, isSuccess },
        'setLeverage test result'
      );
      expect(typeof isSuccess).toBe('boolean');
    });

    test('setMarginMode() completes without throwing', async () => {
      const isSuccess = await connector.setMarginMode(
        BINANCE_TEST_SYMBOL,
        'isolated'
      );
      logger.info(
        { symbol: BINANCE_TEST_SYMBOL, marginMode: 'isolated', isSuccess },
        'setMarginMode test result'
      );
      expect(typeof isSuccess).toBe('boolean');
    });

    test('createOrder() market: opens and closes a position', async () => {
      const ticker = connector.getTicker(
        BINANCE_TEST_SYMBOL,
        MarketType.Futures
      );
      expect(ticker).toBeDefined();

      const openResult = await connector.createOrder({
        symbol: BINANCE_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: MIN_ORDER_QTY,
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      logger.info({ result: openResult }, 'createOrder market open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);
      expect(openResult.orderId).toBeDefined();

      const closeResult = await connector.createOrder({
        symbol: BINANCE_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: MIN_ORDER_QTY,
        price: ticker!.close!,
        type: OrderType.Market,
        marketType: MarketType.Futures,
      });

      logger.info({ result: closeResult }, 'createOrder market close test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('createOrder() limit: opens and closes a position', async () => {
      const ticker = connector.getTicker(
        BINANCE_TEST_SYMBOL,
        MarketType.Futures
      );
      expect(ticker).toBeDefined();
      const currentPrice = ticker!.close!;

      const openResult = await connector.createOrder({
        symbol: BINANCE_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: MIN_ORDER_QTY,
        price: currentPrice * 1.03,
        type: OrderType.Limit,
        marketType: MarketType.Futures,
      });

      logger.info({ result: openResult }, 'createOrder limit open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);
      expect(openResult.orderId).toBeDefined();

      const closeResult = await connector.createOrder({
        symbol: BINANCE_TEST_SYMBOL,
        side: OrderDirection.Sell,
        amount: MIN_ORDER_QTY,
        price: currentPrice * 0.97,
        type: OrderType.Limit,
        marketType: MarketType.Futures,
        params: { reduceOnly: true },
      });

      logger.info({ result: closeResult }, 'createOrder limit close test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('fetchPosition() returns position data', async () => {
      const position = await connector.fetchPosition(BINANCE_TEST_SYMBOL);
      logger.info({ position }, 'fetchPosition test result');

      if (position !== null) {
        expect(position).toHaveProperty('symbol');
        expect(position).toHaveProperty('info');
      }
    });
  });

  describe('OrderCalculator', () => {
    let exchangeConnectorByName: ExchangeConnectorByName;

    beforeAll(() => {
      exchangeConnectorByName = new Map([[exchangeName, connector]]);
    });

    test('resolveSymbolsForExchanges() creates correct mapping', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        TEST_SYMBOLS,
        exchangeConnectorByName
      );

      logger.info(
        { mapping: serializeMapping(mapping) },
        'resolveSymbolsForExchanges test result'
      );
      expect(mapping.size).toBe(1);

      const binanceMap = mapping.get(exchangeName)!;

      for (const symbol of TEST_SYMBOLS) {
        expect(binanceMap.has(symbol)).toBe(true);
      }
    });

    test('getUniqueSymbolCountFromMapping() returns correct count', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        TEST_SYMBOLS,
        exchangeConnectorByName
      );

      const count = OrderCalculator.getUniqueSymbolCountFromMapping(mapping);
      logger.info(
        { count, symbols: TEST_SYMBOLS },
        'getUniqueSymbolCountFromMapping test result'
      );
      expect(count).toBe(TEST_SYMBOLS.length);
    });

    test('createOrderAttributesForSymbol() returns attributes with price', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BINANCE_TEST_SYMBOL],
        exchangeConnectorByName
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName,
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      logger.info(
        { attributes },
        'createOrderAttributesForSymbol test result'
      );
      expect(attributes).toHaveLength(1);
      expect(attributes[0].exchangeName).toBe(exchangeName);
      expect(attributes[0].orderParams.price).toBeGreaterThan(0);
    });

    test('enrichWithSpotFallback() attempts spot fallback for missing symbol', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        ['NONEXISTENT_SYMBOL_XYZ'],
        exchangeConnectorByName
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName,
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      expect(attributes[0].errorText).toBeDefined();

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName,
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      logger.info({ enriched }, 'enrichWithSpotFallback test result');
      expect(enriched).toHaveLength(attributes.length);
    });

    test(`calculateLimitOrderWithPriceAdjustment() adjusts price +${LIMIT_PRICE_ADJUSTMENT_PERCENT}%`, () => {
      const ticker = connector.getTicker(
        BINANCE_TEST_SYMBOL,
        MarketType.Futures
      )!;

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        {
          symbol: BINANCE_TEST_SYMBOL,
          side: OrderDirection.Buy,
          amount: MIN_ORDER_QTY,
          price: ticker.close!,
          type: OrderType.Market,
          marketType: MarketType.Futures,
        },
        LIMIT_PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      logger.info(
        { originalPrice: ticker.close, limitOrder },
        'calculateLimitOrderWithPriceAdjustment test result'
      );
      expect(limitOrder.type).toBe(OrderType.Limit);
      expect(limitOrder.price).toBeGreaterThan(ticker.close!);
    });

    test('calculateCloseOrder() creates correct TP and SL orders', () => {
      const ticker = connector.getTicker(
        BINANCE_TEST_SYMBOL,
        MarketType.Futures
      )!;

      const baseParams = {
        symbol: BINANCE_TEST_SYMBOL,
        side: OrderDirection.Buy,
        amount: MIN_ORDER_QTY,
        price: ticker.close!,
        type: OrderType.Market as OrderType,
        marketType: MarketType.Futures,
      };

      const takeProfit = OrderCalculator.calculateCloseOrder(
        baseParams,
        10,
        true
      );
      const stopLoss = OrderCalculator.calculateCloseOrder(
        baseParams,
        -5,
        false
      );
      logger.info(
        { takeProfit, stopLoss },
        'calculateCloseOrder test result'
      );

      expect(takeProfit.side).toBe(OrderDirection.Sell);
      expect(takeProfit.type).toBe(OrderType.Limit);
      expect(takeProfit.price).toBeGreaterThan(ticker.close!);
      expect(takeProfit.triggerPrice).toBeUndefined();

      expect(stopLoss.side).toBe(OrderDirection.Sell);
      expect(stopLoss.triggerPrice).toBeDefined();
      expect(stopLoss.triggerPrice).toBeLessThan(ticker.close!);
    });

    test('setupLeverageAndMarginMode() completes without error', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BINANCE_TEST_SYMBOL],
        exchangeConnectorByName
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginMode({
          exchangeConnectorByName,
          symbolMappingByExchange: mapping,
          leverage: 5,
        })
      ).resolves.not.toThrow();
      logger.info('setupLeverageAndMarginMode test completed');
    });
  });
});
