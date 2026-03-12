import {
  connectClient,
  parseSymbolFromSignalTitle,
  SignalEmulatorServer,
  waitForMessage,
} from './helpers/signalEmulator.helper';
import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BYBIT_DEMO_CONFIG,
  BYBIT_FUTURES_TEST_SYMBOL,
  calculateTestAmount,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

import { OrderCalculator } from '../../src/core/orderCalculator';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeNameEnum,
  MarketType,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';


const BINANCE_LISTING_SIGNAL = `Binance Futures Will Launch USDⓈ-Margined ${BINANCE_FUTURES_TEST_SYMBOL} Perpetual Contract`;
const BYBIT_LISTING_SIGNAL =
  '[BYBIT] New Listing: Bitcoin (BTC) Will Be Available on Bybit';
const FALLBACK_SIGNAL =
  'Binance Futures Will Launch USDⓈ-Margined CFGUSDT Perpetual Contract';

describeIfCredentials(
  ExchangeNameEnum.Binance,
  'Binance E2E Signal → Order',
  () => {
    let connector: ExchangeConnector;
    let server: SignalEmulatorServer;
    let port: number;
    const exchangeName = ExchangeNameEnum.Binance;

    beforeAll(async () => {
      connector = new ExchangeConnector(exchangeName, BINANCE_DEMO_CONFIG);
      await connector.initialize();
      await waitForTickers(connector, BINANCE_FUTURES_TEST_SYMBOL);

      server = new SignalEmulatorServer();
      port = await server.start();
    }, 60000);

    afterAll(async () => {
      await server.stop();
      await connector.disconnect();
    }, 30000);

    test('receives and parses listing signal', async () => {
      const client = await connectClient(port);
      const messagePromise = waitForMessage(client);

      server.sendSignal({
        source: 'BINANCE',
        title: BINANCE_LISTING_SIGNAL,
        id: 'test_binance_listing',
      });

      const message = await messagePromise;

      expect(message.source).toBe('BINANCE');
      expect(message.title).toBe(BINANCE_LISTING_SIGNAL);

      const symbol = parseSymbolFromSignalTitle(message.title);

      expect(symbol).toBe(BINANCE_FUTURES_TEST_SYMBOL);

      client.close();
    });

    test('creates futures order from listing signal', async () => {
      const client = await connectClient(port);
      const messagePromise = waitForMessage(client);

      server.sendSignal({
        source: 'BINANCE',
        title: BINANCE_LISTING_SIGNAL,
        id: 'test_binance_order',
      });

      const message = await messagePromise;
      const symbol = parseSymbolFromSignalTitle(message.title)!;

      expect(symbol).toBe(BINANCE_FUTURES_TEST_SYMBOL);

      const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
      const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);

      expect(ticker?.lastPrice).toBeGreaterThan(0);

      const amount = calculateTestAmount(connector, symbol, ticker!.lastPrice);

      const orderResult = await connector.createOrder({
        symbol,
        side: OrderSideEnum.Buy,
        amount,
        price: ticker!.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketType.Futures,
      });

      expect(isOrderSuccessful(orderResult)).toBe(true);

      const closeResult = await connector.createOrder({
        symbol,
        side: OrderSideEnum.Sell,
        amount,
        price: ticker!.lastPrice,
        type: OrderTypeEnum.Market,
        marketType: MarketType.Futures,
      });

      expect(isOrderSuccessful(closeResult)).toBe(true);

      client.close();
    });

    test('falls back to spot when futures symbol unavailable', async () => {
      const client = await connectClient(port);
      const messagePromise = waitForMessage(client);

      server.sendSignal({
        source: 'BINANCE',
        title: FALLBACK_SIGNAL,
        id: 'test_binance_fallback',
      });

      const message = await messagePromise;
      const symbol = parseSymbolFromSignalTitle(message.title)!;

      expect(symbol).toBe('CFGUSDT');

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

      expect(attributes[0].errorText).toContain('No price data available');

      const enriched = OrderCalculator.enrichWithSpotFallback({
        orderAttributesList: attributes,
        exchangeConnectorByName: new Map([[exchangeName, connector]]),
        stopBuyAfterPercent: 50,
        orderVolumeUsdt: 100,
        leverage: 5,
        uniqueSymbolCount: 1,
      });

      expect(enriched[0].orderParams.marketType).toBe(MarketType.Spot);

      client.close();
    });
  }
);

describeIfCredentials(ExchangeNameEnum.Bybit, 'Bybit E2E Signal → Order', () => {
  let connector: ExchangeConnector;
  let server: SignalEmulatorServer;
  let port: number;
  const exchangeName = ExchangeNameEnum.Bybit;

  beforeAll(async () => {
    connector = new ExchangeConnector(exchangeName, BYBIT_DEMO_CONFIG);
    await connector.initialize();
    await waitForTickers(connector, BYBIT_FUTURES_TEST_SYMBOL);

    server = new SignalEmulatorServer();
    port = await server.start();
  }, 60000);

  afterAll(async () => {
    await server.stop();
    await connector.disconnect();
  }, 30000);

  test('receives and parses listing signal', async () => {
    const client = await connectClient(port);
    const messagePromise = waitForMessage(client);

    server.sendSignal({
      source: 'BYBIT',
      title: BYBIT_LISTING_SIGNAL,
      id: 'test_bybit_listing',
    });

    const message = await messagePromise;

    expect(message.source).toBe('BYBIT');
    expect(message.title).toBe(BYBIT_LISTING_SIGNAL);

    const symbol = parseSymbolFromSignalTitle(message.title);

    expect(symbol).toBe('BTCUSDT');

    client.close();
  });

  test('creates futures order from listing signal', async () => {
    const client = await connectClient(port);
    const messagePromise = waitForMessage(client);

    server.sendSignal({
      source: 'BYBIT',
      title: BYBIT_LISTING_SIGNAL,
      id: 'test_bybit_order',
    });

    const message = await messagePromise;
    const symbol = parseSymbolFromSignalTitle(message.title)!;

    expect(symbol).toBe(BYBIT_FUTURES_TEST_SYMBOL);

    const resolvedSymbol = connector.resolveSymbolWithPrefix(symbol);
    const ticker = connector.getTicker(resolvedSymbol, MarketType.Futures);

    expect(ticker?.lastPrice).toBeGreaterThan(0);

    const amount = calculateTestAmount(connector, symbol, ticker!.lastPrice);

    const orderResult = await connector.createOrder({
      symbol,
      side: OrderSideEnum.Buy,
      amount,
      price: ticker!.lastPrice,
      type: OrderTypeEnum.Market,
      marketType: MarketType.Futures,
    });

    expect(isOrderSuccessful(orderResult)).toBe(true);

    const closeResult = await connector.createOrder({
      symbol,
      side: OrderSideEnum.Sell,
      amount,
      price: ticker!.lastPrice,
      type: OrderTypeEnum.Market,
      marketType: MarketType.Futures,
    });

    expect(isOrderSuccessful(closeResult)).toBe(true);

    client.close();
  });

  test('falls back to spot when futures symbol unavailable', async () => {
    const client = await connectClient(port);
    const messagePromise = waitForMessage(client);

    server.sendSignal({
      source: 'BYBIT',
      title: FALLBACK_SIGNAL,
      id: 'test_bybit_fallback',
    });

    const message = await messagePromise;
    const symbol = parseSymbolFromSignalTitle(message.title)!;

    expect(symbol).toBe('CFGUSDT');

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

    expect(attributes[0].errorText).toContain('No price data available');

    const enriched = OrderCalculator.enrichWithSpotFallback({
      orderAttributesList: attributes,
      exchangeConnectorByName: new Map([[exchangeName, connector]]),
      stopBuyAfterPercent: 50,
      orderVolumeUsdt: 100,
      leverage: 5,
      uniqueSymbolCount: 1,
    });

    expect(enriched[0].orderParams.marketType).toBe(MarketType.Spot);

    client.close();
  });
});
