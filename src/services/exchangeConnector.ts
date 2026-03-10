import * as crypto from 'crypto';

import { Exchange as ExchangeInstance, ExchangeName, MarginMode, TradeSymbolType } from '@solncebro/exchange-engine';
import type { ExchangeClient, Position, Ticker, TickerBySymbol } from '@solncebro/exchange-engine';

import { logger } from '../core/logger';
import {
  ExchangeConfig,
  MarketType,
  OrderParams,
  OrderResult,
  OrderType,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isSpot } from '../utils/order.utils';
import { normalizeSymbol } from '../utils/symbol.utils';

export class ExchangeConnector {
  private exchange: ExchangeInstance;
  private exchangeName: ExchangeName;
  private tickerDataMap: Map<string, Ticker> = new Map();
  private isWatchingTickers: boolean = false;
  private tickerUpdateIntervalId: NodeJS.Timeout | null = null;

  constructor(
    exchangeName: ExchangeName,
    config: ExchangeConfig
  ) {
    this.exchangeName = exchangeName;

    this.exchange = new ExchangeInstance(exchangeName, {
      config: { apiKey: config.apiKey, secret: config.secret, isDemoMode: config.demo },
      logger,
    });
  }

  public async initialize(): Promise<void> {
    try {
      await this.exchange.futures.loadTradeSymbols();
      await this.exchange.spot.loadTradeSymbols();
      this.startWatchingTickers();
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to initialize exchange'
      );
      throw error;
    }
  }

  private async startWatchingTickers(): Promise<void> {
    if (this.isWatchingTickers) {
      return;
    }

    this.isWatchingTickers = true;
    await this.updateTickers();

    this.tickerUpdateIntervalId = setInterval(async () => {
      if (!this.isWatchingTickers) {
        clearInterval(this.tickerUpdateIntervalId!);
        this.tickerUpdateIntervalId = null;
        return;
      }
      await this.updateTickers();
    }, 30000);
  }

  private async updateTickers(): Promise<void> {
    try {
      const [futuresTickers, spotTickers] = await Promise.all([
        this.exchange.futures.fetchTickers(),
        this.exchange.spot.fetchTickers(),
      ]);
      this.processTickerList(futuresTickers, MarketType.Futures);
      this.processTickerList(spotTickers, MarketType.Spot);
    } catch (error) {
      logger.warn({ error }, 'Failed to update tickers');
    }
  }

  private processTickerList(
    tickers: TickerBySymbol,
    marketType: MarketType = MarketType.Futures
  ): void {
    for (const [symbol, ticker] of tickers) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const tickerKey = this.getTickerKey(normalizedSymbol, marketType);
      this.tickerDataMap.set(tickerKey, ticker);
    }
  }

  private getTickerKey(symbol: string, marketType?: MarketType): string {
    const type = marketType ?? MarketType.Futures;
    return `${type}:${symbol}`;
  }

  private readonly SYMBOL_PREFIX_LIST = [10, 100, 1000, 10000, 100000, 1000000];

  public resolveSymbolWithPrefix(
    symbol: string,
    marketType?: MarketType
  ): string {
    const defaultMarketType = marketType ?? MarketType.Futures;
    const tickerKey = this.getTickerKey(symbol, defaultMarketType);

    if (this.tickerDataMap.has(tickerKey)) {
      return symbol;
    }

    for (const prefix of this.SYMBOL_PREFIX_LIST) {
      const prefixedSymbol = `${prefix}${symbol}`;
      const prefixedTickerKey = this.getTickerKey(
        prefixedSymbol,
        defaultMarketType
      );

      if (this.tickerDataMap.has(prefixedTickerKey)) {
        logger.info(
          {
            originalSymbol: symbol,
            resolvedSymbol: prefixedSymbol,
            exchange: this.exchangeName,
            marketType: defaultMarketType,
          },
          'Symbol resolved with prefix'
        );

        return prefixedSymbol;
      }
    }

    logger.warn(
      {
        symbol,
        exchange: this.exchangeName,
        marketType: defaultMarketType,
        testedPrefixes: this.SYMBOL_PREFIX_LIST,
      },
      'Symbol not found with any prefix'
    );

    return symbol;
  }

  public getTicker(
    symbol: string,
    marketType?: MarketType
  ): Ticker | undefined {
    const tickerKey = this.getTickerKey(symbol, marketType);
    return this.tickerDataMap.get(tickerKey);
  }

  public async createOrder(orderParams: OrderParams): Promise<OrderResult> {
    const resultBase = {
      exchangeName: this.exchangeName,
      orderParams,
    };

    const client = isSpot(orderParams.marketType)
      ? this.exchange.spot
      : this.exchange.futures;

    try {
      const params = this.buildOrderParams(orderParams, client);
      const order = await client.createOrderWebSocket({
        symbol: orderParams.symbol,
        type: orderParams.type,
        side: orderParams.side,
        amount: orderParams.amount,
        price: orderParams.price ?? 0,
        params,
      });

      return {
        ...resultBase,
        orderId: order.id,
        actualExchangeParams: { symbol: orderParams.symbol, side: orderParams.side, ...params },
        responseData: { id: order.id, orderId: order.id, symbol: order.symbol },
      };
    } catch (error) {
      const errorMessage = formatErrorMessage({
        customMessage: 'Failed to create order',
        error,
      });
      logger.error(
        { error, orderParams, exchange: this.exchangeName },
        errorMessage
      );

      return {
        ...resultBase,
        errorText: errorMessage,
        actualExchangeParams: undefined,
      };
    }
  }

  private buildOrderParams(
    orderParams: OrderParams,
    client: ExchangeClient
  ): Record<string, unknown> {
    const params: Record<string, unknown> = { ...orderParams.params };

    if (!isSpot(orderParams.marketType)) {
      params.hedgeMode = true;
    }

    if (this.exchangeName === ExchangeName.Bybit) {
      params.timeInForce =
        orderParams.type === OrderType.Market ? 'IOC' : 'GTC';
      if (orderParams.triggerPrice !== undefined) {
        params.triggerPrice = client.priceToPrecision(
          orderParams.symbol,
          orderParams.triggerPrice
        );
        params.triggerDirection = orderParams.triggerDirection;
      }
    }

    return params;
  }

  public async fetchPosition(symbol: string): Promise<Position | null> {
    try {
      const position = await this.exchange.futures.fetchPosition(symbol);
      return position;
    } catch (error) {
      logger.error(
        { error, symbol, exchange: this.exchangeName },
        'Failed to fetch position'
      );

      return null;
    }
  }

  public async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      await this.exchange.futures.setLeverage(leverage, symbol);
      return true;
    } catch {
      return false;
    }
  }

  public async setMarginMode(
    symbol: string,
    marginMode: MarginMode
  ): Promise<boolean> {
    try {
      await this.exchange.futures.setMarginMode(marginMode, symbol);
      return true;
    } catch {
      return false;
    }
  }

  public async getFuturesSymbols(): Promise<string[]> {
    try {
      const tradeSymbols = this.exchange.futures.tradeSymbols;

      const filteredSymbols = [...tradeSymbols.values()]
        .filter(m => m.isActive && (m.type === TradeSymbolType.Swap || m.type === TradeSymbolType.Future) && m.isLinear)
        .map(m =>
          this.exchangeName === ExchangeName.Bybit ? normalizeSymbol(m.symbol) : m.symbol
        );

      logger.info(
        {
          exchange: this.exchangeName,
          futuresCount: filteredSymbols.length,
          sampleSymbols: filteredSymbols.slice(0, 5),
        },
        'Futures symbols filtered'
      );

      return filteredSymbols;
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to get futures symbols'
      );

      return [];
    }
  }

  public async getSpotSymbols(): Promise<string[]> {
    try {
      const tradeSymbols = this.exchange.spot.tradeSymbols;

      const filteredSymbols = [...tradeSymbols.values()]
        .filter(m => m.isActive && m.type === TradeSymbolType.Spot)
        .map(m =>
          this.exchangeName === ExchangeName.Bybit ? normalizeSymbol(m.symbol) : m.symbol
        );

      logger.info(
        {
          exchange: this.exchangeName,
          spotCount: filteredSymbols.length,
          sampleSymbols: filteredSymbols.slice(0, 5),
        },
        'Spot symbols filtered'
      );

      return filteredSymbols;
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to get spot symbols'
      );

      return [];
    }
  }

  public getClient(marketType?: MarketType): ExchangeClient {
    return isSpot(marketType) ? this.exchange.spot : this.exchange.futures;
  }

  public getExchangeName(): ExchangeName {
    return this.exchangeName;
  }

  public getAccountId(): string {
    const apiKey = this.exchange.futures.apiKey;
    if (!apiKey) {
      logger.warn('No API key available to generate account ID');
      return 'default';
    }

    const hash = crypto
      .createHash('sha256')
      .update(apiKey)
      .digest('hex');

    return hash.substring(0, 16);
  }

  public async disconnect(): Promise<void> {
    this.isWatchingTickers = false;

    if (this.tickerUpdateIntervalId) {
      clearInterval(this.tickerUpdateIntervalId);
      this.tickerUpdateIntervalId = null;
      logger.debug(
        { exchange: this.exchangeName },
        'Cleared ticker update interval'
      );
    }

    try {
      await this.exchange.close();
      logger.info(
        { exchange: this.exchangeName },
        'Exchange connection closed'
      );
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Error closing exchange connection'
      );
    }
  }
}
