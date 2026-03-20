import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
  describeIfCredentials,
  MIN_TEST_USDT,
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

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit Spot Fallback Integration', () => {
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

  describe('Spot Fallback', () => {
    test('futures ticker exists for real symbols', () => {
      const ticker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      expect(ticker).toBeDefined();
      expect(ticker!.lastPrice).toBeGreaterThan(0);
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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributes[0].errorText).toBeDefined();
      expect(attributes[0].orderParams.marketType).toBe(MarketTypeEnum.Futures);

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(enriched[0].orderParams.marketType).toBe(MarketTypeEnum.Spot);
    });

    test('creates actual spot market order when fallback succeeds', async () => {
      OrderCalculator.resolveSymbolsForExchanges(
        [BYBIT_FUTURES_TEST_SYMBOL],
        new Map([[exchangeName, connector]])
      );

      const spotTicker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Spot);

      if (!spotTicker?.lastPrice) {
        console.warn(`Spot ticker for ${BYBIT_FUTURES_TEST_SYMBOL} not yet loaded, skipping test`);
        return;
      }

      const spotQty = connector.getClient(MarketTypeEnum.Spot).amountToPrecision(BYBIT_FUTURES_TEST_SYMBOL, MIN_TEST_USDT / spotTicker.lastPrice);

      const spotOrderResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: spotQty,
        price: spotTicker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Spot,
      });

      expect(isOrderSuccessful(spotOrderResult)).toBe(true);
      expect(spotOrderResult.orderId).toBeDefined();

      const closeResult = await connector.createOrder({
        symbol: BYBIT_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount: spotQty,
        price: spotTicker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Spot,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('spot and futures tickers are independently tracked', () => {
      const futuresTicker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);
      const spotTicker = connector.getTicker(BYBIT_FUTURES_TEST_SYMBOL, MarketTypeEnum.Spot);

      expect(futuresTicker).toBeDefined();
      expect(spotTicker).toBeDefined();
      expect(futuresTicker!.lastPrice).toBeGreaterThan(0);
      expect(spotTicker!.lastPrice).toBeGreaterThan(0);
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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(enriched[0].orderParams.symbol).toBe(symbol);
      expect(enriched[0].orderParams.marketType).toBe(MarketTypeEnum.Spot);
    });
  });
});

describeIfCredentials(ExchangeNameEnum.Binance, 'Binance Spot Fallback Integration', () => {
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
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(attributes[0].orderParams.marketType).toBe(MarketTypeEnum.Futures);

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        allowedVolumeByExchange: new Map([[exchangeName, 100]]),
        leverage: 5,
      });

      expect(enriched[0].orderParams.marketType).toBe(MarketTypeEnum.Spot);
    });

    test('creates actual spot order on Binance', async () => {
      const spotTicker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketTypeEnum.Spot);

      if (!spotTicker?.lastPrice) {
        console.warn(`Spot ticker for ${BINANCE_FUTURES_TEST_SYMBOL} not yet loaded on Binance, skipping`);
        return;
      }

      const binanceSpotQty = connector.getClient(MarketTypeEnum.Spot).amountToPrecision(BINANCE_FUTURES_TEST_SYMBOL, MIN_TEST_USDT / spotTicker.lastPrice);

      const openResult = await connector.createOrder({
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount: binanceSpotQty,
        price: spotTicker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Spot,
      });

      expect(isOrderSuccessful(openResult)).toBe(true);

      const closeResult = await connector.createOrder({
        symbol: BINANCE_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount: binanceSpotQty,
        price: spotTicker.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Spot,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('spot ticker loading works independently from futures', () => {
      const spotTicker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketTypeEnum.Spot);
      const futuresTicker = connector.getTicker(BINANCE_FUTURES_TEST_SYMBOL, MarketTypeEnum.Futures);

      expect(spotTicker).toBeDefined();
      expect(futuresTicker).toBeDefined();
      expect(spotTicker!.lastPrice).toBeGreaterThan(0);
      expect(futuresTicker!.lastPrice).toBeGreaterThan(0);
    });
  });
});
