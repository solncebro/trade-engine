import {
  BINANCE_DEMO_CONFIG,
  BINANCE_FUTURES_TEST_SYMBOL,
  BINANCE_FUTURES_TEST_SYMBOL_LIST,
  calculateTestAmount,
  createDemoConnector,
  describeIfCredentials,
  waitForTickers,
} from './helpers/testnet.helpers';

import { logger } from '../../src/core/logger';
import { ExchangeConnector } from '../../src/services/exchangeConnector';
import {
  ExchangeNameEnum,
  MarginModeEnum,
  MarketTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
} from '../../src/types';
import { isOrderSuccessful } from '../../src/utils/order.utils';

const TEST_LEVERAGE = 5;

describeIfCredentials(
  ExchangeNameEnum.Binance,
  'Binance Demo Integration',
  () => {
    let connector: ExchangeConnector;

    beforeAll(async () => {
      connector = await createDemoConnector(
        ExchangeNameEnum.Binance,
        BINANCE_DEMO_CONFIG
      );
      await waitForTickers(connector, BINANCE_FUTURES_TEST_SYMBOL);
    }, 60000);

    afterAll(async () => {
      await connector.disconnect();
    }, 30000);

    describe('ExchangeConnector', () => {
      test('getExchangeName() returns binance', () => {
        const result = connector.getExchangeName();
        logger.info({ result }, 'getExchangeName test result');
        expect(result).toBe(ExchangeNameEnum.Binance);
      });

      test('getAccountId() returns a 16-char hash string', () => {
        const accountId = connector.getAccountId();
        logger.info({ accountId }, 'getAccountId test result');
        expect(accountId).toMatch(/^[a-f0-9]{16}$/);
      });

      test('getFuturesSymbols() returns non-empty list with ETH', async () => {
        const symbolList = await connector.getFuturesSymbols();
        logger.info(
          {
            count: symbolList.length,
            sample: [...symbolList].sort().slice(0, 20),
          },
          'getFuturesSymbols test result'
        );
        expect(symbolList.length).toBeGreaterThan(0);
        expect(symbolList).toEqual(
          expect.arrayContaining([expect.stringContaining('ETH')])
        );
      });

      test('getSpotSymbols() returns non-empty list', async () => {
        const symbolList = await connector.getSpotSymbols();
        logger.info(
          {
            count: symbolList.length,
            sample: [...symbolList].sort().slice(0, 20),
          },
          'getSpotSymbols test result'
        );
        expect(symbolList.length).toBeGreaterThan(0);
      });

      test('getTicker() returns price data for futures', () => {
        const ticker = connector.getTicker(
          BINANCE_FUTURES_TEST_SYMBOL,
          MarketTypeEnum.Futures
        );
        logger.info({ ticker }, 'getTicker test result');
        expect(ticker).toBeDefined();
        expect(ticker!.lastPrice).toBeGreaterThan(0);
      });

      test('resolveSymbolWithPrefix() resolves FLOKIUSDT → 1000FLOKIUSDT, SHIBUSDT → 1000SHIBUSDT', () => {
        const resolvedBySymbol: Record<string, string> = {};

        for (const symbol of BINANCE_FUTURES_TEST_SYMBOL_LIST) {
          resolvedBySymbol[symbol] = connector.resolveSymbolWithPrefix(
            symbol,
            MarketTypeEnum.Futures
          );
        }

        logger.info({ resolvedBySymbol }, 'resolveSymbolWithPrefix test result');

        expect(resolvedBySymbol['ETHUSDT']).toBe('ETHUSDT');
        expect(resolvedBySymbol['FLOKIUSDT']).toBe('1000FLOKIUSDT');
        expect(resolvedBySymbol['SHIBUSDT']).toBe('1000SHIBUSDT');
      });

      test('futures.setLeverage() confirms the requested leverage', async () => {
        const result = await connector.futures.setLeverage(
          TEST_LEVERAGE,
          BINANCE_FUTURES_TEST_SYMBOL
        );
        logger.info({ result }, 'setLeverage test result');
        expect(result.confirmedLeverage).toBe(TEST_LEVERAGE);
      });

      test('futures.setMarginMode() completes without throwing', async () => {
        await expect(
          connector.futures.setMarginMode(
            MarginModeEnum.Isolated,
            BINANCE_FUTURES_TEST_SYMBOL
          )
        ).resolves.not.toThrow();
      });

      test('createOrder() market: opens and closes a position', async () => {
        const ticker = connector.getTicker(
          BINANCE_FUTURES_TEST_SYMBOL,
          MarketTypeEnum.Futures
        );
        expect(ticker).toBeDefined();

        const amount = calculateTestAmount(
          connector,
          BINANCE_FUTURES_TEST_SYMBOL,
          ticker!.lastPrice!
        );

        const openResult = await connector.createOrder({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          side: OrderSideEnum.Buy,
          amount,
          price: ticker!.lastPrice!,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
        });

        logger.info({ result: openResult }, 'createOrder market open test result');
        expect(isOrderSuccessful(openResult)).toBe(true);

        const closeResult = await connector.createOrder({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          side: OrderSideEnum.Sell,
          amount,
          price: ticker!.lastPrice!,
          type: OrderTypeEnum.Market,
          marketType: MarketTypeEnum.Futures,
          reduceOnly: true,
        });

        logger.info(
          { result: closeResult },
          'createOrder market close test result'
        );
        expect(isOrderSuccessful(closeResult)).toBe(true);
      });

      test('createOrder() limit: places a resting order and cancels it', async () => {
        const ticker = connector.getTicker(
          BINANCE_FUTURES_TEST_SYMBOL,
          MarketTypeEnum.Futures
        );
        expect(ticker).toBeDefined();

        const currentPrice = ticker!.lastPrice!;
        const amount = calculateTestAmount(
          connector,
          BINANCE_FUTURES_TEST_SYMBOL,
          currentPrice
        );
        const restingPrice = connector.futures.priceToPrecision(
          BINANCE_FUTURES_TEST_SYMBOL,
          currentPrice * 0.9
        );

        const openResult = await connector.createOrder({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
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
            BINANCE_FUTURES_TEST_SYMBOL,
            openResult.orderId!
          )
        ).resolves.toBeDefined();
      });

      test('futures.fetchPosition() returns position data or reports it absent', async () => {
        try {
          const position = await connector.futures.fetchPosition(
            BINANCE_FUTURES_TEST_SYMBOL
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
          BINANCE_FUTURES_TEST_SYMBOL,
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
    });

    describe('PositionManager', () => {
      test('readAllPositions() returns a list for futures', async () => {
        const positionList = await connector.positionManager.readAllPositions({
          marketType: MarketTypeEnum.Futures,
        });
        logger.info(
          { count: positionList.length },
          'readAllPositions test result'
        );
        expect(Array.isArray(positionList)).toBe(true);
      });

      test('readPositionState() reports a known kind for a flat symbol', async () => {
        const state = await connector.positionManager.readPositionState({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          marketType: MarketTypeEnum.Futures,
          direction: 'long',
        });
        logger.info({ state }, 'readPositionState test result');
        expect(['present', 'absent', 'ambiguous']).toContain(state.kind);
        expect(state.kind === 'absent' && state.confidence === 'unconfirmed').toBe(false);
      });

      test('setLeverage() returns the leverage the exchange confirmed', async () => {
        const result = await connector.positionManager.setLeverage({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          leverage: TEST_LEVERAGE,
        });
        logger.info({ result }, 'positionManager setLeverage test result');
        expect(result.confirmedLeverage).toBe(TEST_LEVERAGE);
      });

      test('openPositionMarket() then closePositionMarket() round-trips a long', async () => {
        const ticker = connector.getTicker(
          BINANCE_FUTURES_TEST_SYMBOL,
          MarketTypeEnum.Futures
        );
        expect(ticker).toBeDefined();

        const amount = calculateTestAmount(
          connector,
          BINANCE_FUTURES_TEST_SYMBOL,
          ticker!.lastPrice!
        );

        const openResult = await connector.positionManager.openPositionMarket({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          marketType: MarketTypeEnum.Futures,
          direction: 'long',
          amount,
        });

        logger.info({ result: openResult }, 'openPositionMarket test result');
        expect(isOrderSuccessful(openResult)).toBe(true);

        const closeResult = await connector.positionManager.closePositionMarket({
          symbol: BINANCE_FUTURES_TEST_SYMBOL,
          marketType: MarketTypeEnum.Futures,
          direction: 'long',
          amount,
        });

        logger.info({ result: closeResult }, 'closePositionMarket test result');
        expect(isOrderSuccessful(closeResult)).toBe(true);
      });
    });
  }
);
