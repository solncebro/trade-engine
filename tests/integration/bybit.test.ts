import {
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
  BYBIT_FUTURES_TEST_SYMBOL_LIST,
  BYBIT_SPOT_FALLBACK_SYMBOL,
  calculateTestAmount,
  describeIfCredentials,
  serializeMapping,
  waitForTickers,
} from './helpers/testnet.helpers';

import { logger } from '../../src/core/logger';
import { OrderCalculator } from '../../src/core/orderCalculator';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeConnectorByName,
  ExchangeNameEnum,
  MarketTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

const LIMIT_PRICE_ADJUSTMENT_PERCENT = 5;

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit Demo Integration', () => {
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

  describe('ExchangeConnector', () => {
    test('getExchangeName() returns bybit', () => {
      const result = connector.getExchangeName();
      logger.info({ result }, 'getExchangeName test result');
      expect(result).toBe(ExchangeNameEnum.Bybit);
    });

    test('getAccountId() returns a 16-char hash string', () => {
      const accountId = connector.getAccountId();
      logger.info({ accountId }, 'getAccountId test result');
      expect(accountId).toMatch(/^[a-f0-9]{16}$/);
    });

    test('getFuturesSymbols() returns non-empty list with BTC', async () => {
      const symbolList = await connector.getFuturesSymbols();
      logger.info(
        { count: symbolList.length, sample: [...symbolList].sort().slice(0, 20) },
        'getFuturesSymbols test result'
      );
      expect(symbolList.length).toBeGreaterThan(0);
      expect(symbolList).toEqual(
        expect.arrayContaining([expect.stringContaining('BTC')])
      );
    });

    test('getSpotSymbols() returns non-empty list', async () => {
      const symbolList = await connector.getSpotSymbols();
      logger.info(
        { count: symbolList.length, sample: [...symbolList].sort().slice(0, 20) },
        'getSpotSymbols test result'
      );
      expect(symbolList.length).toBeGreaterThan(0);
    });

    test('getTicker() returns price data for futures', () => {
      const ticker = connector.getTicker(
        BYBIT_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      logger.info({ ticker }, 'getTicker test result');
      expect(ticker).toBeDefined();
      expect(ticker!.lastPrice).toBeGreaterThan(0);
    });

    test('resolveSymbolWithPrefix() resolves FLOKIUSDT → 1000FLOKIUSDT, MOGUSDT → 1000000MOGUSDT', () => {
      const resolved: Record<string, string> = {};

      for (const symbol of BYBIT_FUTURES_TEST_SYMBOL_LIST) {
        resolved[symbol] = connector.resolveSymbolWithPrefix(symbol);
      }

      logger.info({ resolved }, 'resolveSymbolWithPrefix test result');

      expect(resolved['BTCUSDT']).toBe('BTCUSDT');
      expect(resolved['10000QUBICUSDT']).toBe('10000QUBICUSDT');
      expect(resolved['FLOKIUSDT']).toBe('1000FLOKIUSDT');
      expect(resolved['MOGUSDT']).toBe('1000000MOGUSDT');
    });

    test('setLeverage() completes without throwing', async () => {
      const isSuccess = await connector.setLeverage(BYBIT_FUTURES_TEST_SYMBOL, 5);
      logger.info(
        { symbol: BYBIT_FUTURES_TEST_SYMBOL, leverage: 5, isSuccess },
        'setLeverage test result'
      );
      expect(typeof isSuccess).toBe('boolean');
    });

    test('setMarginMode() completes without throwing', async () => {
      const isSuccess = await connector.setMarginMode(
        BYBIT_FUTURES_TEST_SYMBOL,
        'isolated'
      );
      logger.info(
        { symbol: BYBIT_FUTURES_TEST_SYMBOL, marginMode: 'isolated', isSuccess },
        'setMarginMode test result'
      );
      expect(typeof isSuccess).toBe('boolean');
    });

    test('createOrder() market: opens and closes a position', async () => {
      const ticker = connector.getTicker(
        BYBIT_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      expect(ticker).toBeDefined();

      const amount = calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker!.lastPrice!);

      const openResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount,
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      logger.info({ result: openResult }, 'createOrder market open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);
      expect(openResult.orderId).toBeDefined();

      const closeResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount,
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
        params: { reduceOnly: true },
      });

      logger.info({ result: closeResult }, 'createOrder market close test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('createOrder() limit: opens and closes a position', async () => {
      const ticker = connector.getTicker(
        BYBIT_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      expect(ticker).toBeDefined();
      const currentPrice = ticker!.lastPrice!;
      const amount = calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, currentPrice);

      const openResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount,
        price: currentPrice * 1.05,
        type: OrderTypeEnum.Limit,
        marketType: MarketTypeEnum.Futures,
      });

      logger.info({ result: openResult }, 'createOrder limit open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);
      expect(openResult.orderId).toBeDefined();

      const closeResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount,
        price: currentPrice * 0.95,
        type: OrderTypeEnum.Limit,
        marketType: MarketTypeEnum.Futures,
        params: { reduceOnly: true },
      });

      logger.info({ result: closeResult }, 'createOrder limit close test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('fetchPosition() returns position data', async () => {
      const position = await connector.fetchPosition(BYBIT_FUTURES_TEST_SYMBOL);
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

    test('resolveSymbolsForExchanges() creates correct mapping with resolved symbols', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        exchangeConnectorByName
      );

      logger.info(
        { mapping: serializeMapping(mapping) },
        'resolveSymbolsForExchanges test result'
      );
      expect(mapping.size).toBe(1);

      const bybitMap = mapping.get(exchangeName)!;
      expect(bybitMap.size).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);

      expect(bybitMap.get('FLOKIUSDT')).toBe('1000FLOKIUSDT');
      expect(bybitMap.get('MOGUSDT')).toBe('1000000MOGUSDT');
      expect(bybitMap.get('BTCUSDT')).toBe('BTCUSDT');
      expect(bybitMap.get('10000QUBICUSDT')).toBe('10000QUBICUSDT');
    });

    test('getUniqueSymbolCountFromMapping() returns correct count', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        BYBIT_FUTURES_TEST_SYMBOL_LIST,
        exchangeConnectorByName
      );

      const count = OrderCalculator.getUniqueSymbolCountFromMapping(mapping);
      logger.info(
        { count, symbols: BYBIT_FUTURES_TEST_SYMBOL_LIST },
        'getUniqueSymbolCountFromMapping test result'
      );
      expect(count).toBe(BYBIT_FUTURES_TEST_SYMBOL_LIST.length);
    });

    test('createOrderAttributesForSymbol() returns attributes with price', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_FUTURES_TEST_SYMBOL],
        exchangeConnectorByName
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName,
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      logger.info(
        { attributes },
        'createOrderAttributesForSymbol test result'
      );
      expect(attributes).toHaveLength(1);
      expect(attributes[0].exchangeName).toBe(exchangeName);
      expect(attributes[0].orderParams.price).toBeGreaterThan(0);
    });

    test('enrichWithSpotFallback() falls back to spot for CFGUSDT', () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_SPOT_FALLBACK_SYMBOL],
        exchangeConnectorByName
      );

      const attributes = OrderCalculator.createOrderAttributesForSymbol({
        isLong: true,
        exchangeConnectorByName,
        symbolMappingByExchange: mapping,
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributes[0].errorText).toBeDefined();

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName,
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      logger.info({ enriched }, 'enrichWithSpotFallback test result');
      expect(enriched).toHaveLength(1);
      expect(enriched[0].orderParams.marketType).toBe(MarketTypeEnum.Spot);
    });

    test(`calculateLimitOrderWithPriceAdjustment() adjusts price +${LIMIT_PRICE_ADJUSTMENT_PERCENT}%`, () => {
      const ticker = connector.getTicker(
        BYBIT_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      )!;

      const limitOrder = OrderCalculator.calculateLimitOrderWithPriceAdjustment(
        {
          symbol: BYBIT_FUTURES_TEST_SYMBOL,
          side: OrderSideEnum.Buy,
          amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker.lastPrice!),
          price: ticker.lastPrice!,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        },
        LIMIT_PRICE_ADJUSTMENT_PERCENT,
        100,
        5
      );

      logger.info(
        { originalPrice: ticker.lastPrice, limitOrder },
        'calculateLimitOrderWithPriceAdjustment test result'
      );
      expect(limitOrder.type).toBe(OrderTypeEnum.Limit);
      expect(limitOrder.price).toBeGreaterThan(ticker.lastPrice!);
    });

    test('calculateCloseOrder() creates correct TP and SL orders', () => {
      const ticker = connector.getTicker(
        BYBIT_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      )!;

      const baseParams = {
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: calculateTestAmount(connector, BYBIT_FUTURES_TEST_SYMBOL, ticker.lastPrice!),
        price: ticker.lastPrice!,
        type: OrderTypeEnum.Market as OrderTypeEnum,
        marketType: MarketTypeEnum.Futures,
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

      expect(takeProfit.side).toBe(OrderSideEnum.Sell);
      expect(takeProfit.type).toBe(OrderTypeEnum.Limit);
      expect(takeProfit.price).toBeGreaterThan(ticker.lastPrice!);
      expect(takeProfit.triggerPrice).toBeUndefined();

      expect(stopLoss.side).toBe(OrderSideEnum.Sell);
      expect(stopLoss.triggerPrice).toBeDefined();
      expect(stopLoss.triggerPrice).toBeLessThan(ticker.lastPrice!);
    });

    test('setupLeverageAndMarginModeEnum() completes without error', async () => {
      const mapping = OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_FUTURES_TEST_SYMBOL],
        exchangeConnectorByName
      );

      await expect(
        OrderCalculator.setupLeverageAndMarginModeEnum({
          exchangeConnectorByName,
          symbolMappingByExchange: mapping,
          leverage: 5,
        })
      ).resolves.not.toThrow();
      logger.info('setupLeverageAndMarginModeEnum test completed');
    });
  });
});
