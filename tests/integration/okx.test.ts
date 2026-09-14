import {
  calculateTestAmount,
  createDemoConnector,
  describeIfCredentials,
  OKX_DEMO_CONFIG,
  OKX_FUTURES_TEST_SYMBOL,
  OKX_FUTURES_TEST_SYMBOL_LIST,
  waitForTickers,
} from './helpers/testnet.helpers';

import { logger } from '../../src/core/logger';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import { resolveOrderBookStreamDepth } from '../../src/services/orderBookTracker';
import {
  ExchangeNameEnum,
  MarginModeEnum,
  MarketTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

const TEST_LEVERAGE = 5;

describeIfCredentials(ExchangeNameEnum.Okx, 'OKX Demo Integration', () => {
  let connector: ExchangeConnector;

  beforeAll(async () => {
    connector = await createDemoConnector(
      ExchangeNameEnum.Okx,
      OKX_DEMO_CONFIG
    );
    await waitForTickers(connector, OKX_FUTURES_TEST_SYMBOL);
  }, 60000);

  afterAll(async () => {
    await connector.disconnect();
  }, 30000);

  describe('ExchangeConnector', () => {
    test('getExchangeName() returns okx', () => {
      const result = connector.getExchangeName();
      logger.info({ result }, 'getExchangeName test result');
      expect(result).toBe(ExchangeNameEnum.Okx);
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
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      logger.info({ ticker }, 'getTicker test result');
      expect(ticker).toBeDefined();
      expect(ticker!.lastPrice).toBeGreaterThan(0);
    });

    test('resolveSymbolWithPrefix() returns every symbol unchanged — OKX carries the multiplier in ctVal, not in the name', () => {
      const resolvedBySymbol: Record<string, string> = {};

      for (const symbol of OKX_FUTURES_TEST_SYMBOL_LIST) {
        resolvedBySymbol[symbol] = connector.resolveSymbolWithPrefix(
          symbol,
          MarketTypeEnum.Futures
        );
      }

      logger.info({ resolvedBySymbol }, 'resolveSymbolWithPrefix test result');

      for (const symbol of OKX_FUTURES_TEST_SYMBOL_LIST) {
        expect(resolvedBySymbol[symbol]).toBe(symbol);
      }
    });

    test('futures.setLeverage() confirms the requested leverage', async () => {
      const result = await connector.futures.setLeverage(
        TEST_LEVERAGE,
        OKX_FUTURES_TEST_SYMBOL
      );
      logger.info({ result }, 'setLeverage test result');
      expect(result.confirmedLeverage).toBe(TEST_LEVERAGE);
    });

    test('futures.setMarginMode() is remembered by the client rather than rejected', async () => {
      await expect(
        connector.futures.setMarginMode(
          MarginModeEnum.Isolated,
          OKX_FUTURES_TEST_SYMBOL
        )
      ).resolves.not.toThrow();
    });

    test('createOrder() market: opens and closes a position', async () => {
      const ticker = connector.getTicker(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      expect(ticker).toBeDefined();

      const amount = calculateTestAmount(
        connector,
        OKX_FUTURES_TEST_SYMBOL,
        ticker!.lastPrice!
      );

      const openResult = await connector.createOrder({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount,
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
      });

      logger.info({ result: openResult }, 'createOrder market open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);

      const closeResult = await connector.createOrder({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Sell,
        amount,
        price: ticker!.lastPrice!,
        type: OrderTypeEnum.Market,
        marketType: MarketTypeEnum.Futures,
        reduceOnly: true,
      });

      logger.info({ result: closeResult }, 'createOrder market close test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });

    test('createOrder() limit: places a resting order and cancels it', async () => {
      const ticker = connector.getTicker(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      expect(ticker).toBeDefined();

      const currentPrice = ticker!.lastPrice!;
      const amount = calculateTestAmount(
        connector,
        OKX_FUTURES_TEST_SYMBOL,
        currentPrice
      );
      const restingPrice = connector.futures.priceToPrecision(
        OKX_FUTURES_TEST_SYMBOL,
        currentPrice * 0.9
      );

      const openResult = await connector.createOrder({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        side: OrderSideEnum.Buy,
        amount,
        price: restingPrice,
        type: OrderTypeEnum.Limit,
        marketType: MarketTypeEnum.Futures,
      });

      logger.info({ result: openResult }, 'createOrder limit open test result');
      expect(isOrderSuccessful(openResult)).toBe(true);

      await expect(
        connector.futures.cancelOrder(
          OKX_FUTURES_TEST_SYMBOL,
          openResult.orderId!
        )
      ).resolves.toBeDefined();
    });

    test('futures.fetchPosition() returns position data or reports it absent', async () => {
      try {
        const position = await connector.futures.fetchPosition(
          OKX_FUTURES_TEST_SYMBOL
        );
        logger.info({ position }, 'fetchPosition test result');
        expect(position).toHaveProperty('symbol');
        expect(position).toHaveProperty('info');
      } catch (error) {
        logger.info({ error: String(error) }, 'fetchPosition test result');
        expect(String(error)).toContain('Position not found');
      }
    });

    test('fetchOrderBook() returns both sides', async () => {
      const orderBook = await connector.fetchOrderBook(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      logger.info(
        {
          symbol: orderBook.symbol,
          bidCount: orderBook.bidList.length,
          askCount: orderBook.askList.length,
        },
        'fetchOrderBook test result'
      );
      expect(orderBook.bidList.length).toBeGreaterThan(0);
      expect(orderBook.askList.length).toBeGreaterThan(0);
    });

    test('subscribeOrderBook() fills a live book at the deep OKX stream depth', async () => {
      expect(resolveOrderBookStreamDepth(ExchangeNameEnum.Okx)).toBe(400);

      connector.subscribeOrderBook(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );

      const deadlineMs = Date.now() + 30000;
      let liveBook = connector.getOrderBook(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );

      while (liveBook === null && Date.now() < deadlineMs) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        liveBook = connector.getOrderBook(
          OKX_FUTURES_TEST_SYMBOL,
          MarketTypeEnum.Futures
        );
      }

      logger.info(
        {
          bidCount: liveBook?.bidList.length,
          askCount: liveBook?.askList.length,
        },
        'subscribeOrderBook test result'
      );

      expect(liveBook).not.toBeNull();
      // Threshold well above 5 — a shallow book (books5) or a stale/empty book would both
      // pass a bare ">0" check, so it can't tell a deep 400-level channel from a 5-level one.
      expect(liveBook!.bidList.length).toBeGreaterThanOrEqual(50);
      expect(liveBook!.askList.length).toBeGreaterThanOrEqual(50);

      connector.unsubscribeOrderBook(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
    }, 60000);
  });

  describe('PositionManager', () => {
    test('readAllPositions() returns a list for futures', async () => {
      const positionList = await connector.positionManager.readAllPositions({
        marketType: MarketTypeEnum.Futures,
      });
      logger.info({ count: positionList.length }, 'readAllPositions test result');
      expect(Array.isArray(positionList)).toBe(true);
    });

    test('readPositionState() reports a known kind for a flat symbol', async () => {
      const state = await connector.positionManager.readPositionState({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
      });
      logger.info({ state }, 'readPositionState test result');
      expect(['present', 'absent', 'ambiguous']).toContain(state.kind);
      expect(state.kind === 'absent' && state.confidence === 'unconfirmed').toBe(false);
    });

    test('setLeverage() returns the leverage the exchange confirmed', async () => {
      const result = await connector.positionManager.setLeverage({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        leverage: TEST_LEVERAGE,
      });
      logger.info({ result }, 'positionManager setLeverage test result');
      expect(result.confirmedLeverage).toBe(TEST_LEVERAGE);
    });

    test('openPositionMarket() then closePositionMarket() round-trips a long', async () => {
      const ticker = connector.getTicker(
        OKX_FUTURES_TEST_SYMBOL,
        MarketTypeEnum.Futures
      );
      expect(ticker).toBeDefined();

      const amount = calculateTestAmount(
        connector,
        OKX_FUTURES_TEST_SYMBOL,
        ticker!.lastPrice!
      );

      const openResult = await connector.positionManager.openPositionMarket({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount,
      });

      logger.info({ result: openResult }, 'openPositionMarket test result');
      expect(isOrderSuccessful(openResult)).toBe(true);

      const closeResult = await connector.positionManager.closePositionMarket({
        symbol: OKX_FUTURES_TEST_SYMBOL,
        marketType: MarketTypeEnum.Futures,
        direction: 'long',
        amount,
      });

      logger.info({ result: closeResult }, 'closePositionMarket test result');
      expect(isOrderSuccessful(closeResult)).toBe(true);
    });
  });
});
