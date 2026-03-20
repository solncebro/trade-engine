import * as crypto from 'crypto';

import { Exchange as ExchangeInstance, ExchangeNameEnum, MarginModeEnum, OrderSideEnum, PositionModeEnum, PositionSideEnum, TimeInForceEnum, TradeSymbolTypeEnum } from '@solncebro/exchange-engine';
import type { BalanceByAsset, CreateOrderWebSocketArgs, ExchangeClient, FetchPageWithLimitArgs, Order, Position, Ticker, TickerBySymbol, WebSocketConnectionInfo } from '@solncebro/exchange-engine';

import { logger } from '../core/logger';
import {
  ExchangeConfig,
  MarketTypeEnum,
  OrderParams,
  OrderResult,
  OrderTypeEnum,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isSpot } from '../utils/order.utils';
import { normalizeSymbol } from '../utils/symbol.utils';

export class ExchangeConnector {
  private exchange: ExchangeInstance;
  private exchangeName: ExchangeNameEnum;
  private tickersByMarketTypeAndSymbol: Map<string, Ticker> = new Map();
  private isWatchingTickers: boolean = false;
  private tickerUpdateIntervalId: NodeJS.Timeout | null = null;

  constructor(
    exchangeName: ExchangeNameEnum,
    config: ExchangeConfig
  ) {
    this.exchangeName = exchangeName;

    this.exchange = new ExchangeInstance(exchangeName, {
      config,
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
      this.processTickerList(futuresTickers, MarketTypeEnum.Futures);
      this.processTickerList(spotTickers, MarketTypeEnum.Spot);
    } catch (error) {
      logger.warn({ error }, 'Failed to update tickers');
    }
  }

  private processTickerList(
    tickers: TickerBySymbol,
    marketType: MarketTypeEnum
  ): void {
    for (const [symbol, ticker] of tickers) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const tickerKey = this.getTickerKey(normalizedSymbol, marketType);
      this.tickersByMarketTypeAndSymbol.set(tickerKey, ticker);
    }
  }

  private getTickerKey(symbol: string, marketType: MarketTypeEnum): string {
    return `${marketType}:${symbol}`;
  }

  private readonly symbolPrefixList = [10, 100, 1000, 10000, 100000, 1000000];

  public resolveSymbolWithPrefix(
    symbol: string,
    marketType: MarketTypeEnum
  ): string {
    const tickerKey = this.getTickerKey(symbol, marketType);

    if (this.tickersByMarketTypeAndSymbol.has(tickerKey)) {
      return symbol;
    }

    for (const prefix of this.symbolPrefixList) {
      const prefixedSymbol = `${prefix}${symbol}`;
      const prefixedTickerKey = this.getTickerKey(
        prefixedSymbol,
        marketType
      );

      if (this.tickersByMarketTypeAndSymbol.has(prefixedTickerKey)) {
        logger.info(
          {
            originalSymbol: symbol,
            resolvedSymbol: prefixedSymbol,
            exchange: this.exchangeName,
            marketType,
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
        marketType,
        testedPrefixes: this.symbolPrefixList,
      },
      'Symbol not found with any prefix'
    );

    return symbol;
  }

  public getTicker(
    symbol: string,
    marketType: MarketTypeEnum
  ): Ticker | undefined {
    const tickerKey = this.getTickerKey(symbol, marketType);

    return this.tickersByMarketTypeAndSymbol.get(tickerKey);
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
      const wsArgs = this.buildCreateOrderArgs(orderParams, client);
      const order = await client.createOrderWebSocket(wsArgs);

      return {
        ...resultBase,
        orderId: order.id,
        actualExchangeParams: { ...wsArgs },
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

  private buildCreateOrderArgs(
    orderParams: OrderParams,
    client: ExchangeClient
  ): CreateOrderWebSocketArgs {
    const args: CreateOrderWebSocketArgs = {
      symbol: orderParams.symbol,
      type: orderParams.type,
      side: orderParams.side,
      amount: client.amountToPrecision(orderParams.symbol, orderParams.amount),
      price: orderParams.price ? client.priceToPrecision(orderParams.symbol, orderParams.price) : 0,
    };

    if (!isSpot(orderParams.marketType)) {
      args.positionSide = orderParams.side === OrderSideEnum.Buy
        ? PositionSideEnum.Long
        : PositionSideEnum.Short;
    }

    if (orderParams.params?.reduceOnly) {
      args.reduceOnly = true;
    }

    args.timeInForce = orderParams.type === OrderTypeEnum.Market
      ? TimeInForceEnum.Ioc
      : TimeInForceEnum.Gtc;

    if (orderParams.triggerPrice !== undefined) {
      args.stopPrice = client.priceToPrecision(
        orderParams.symbol,
        orderParams.triggerPrice
      );
    }

    if (orderParams.triggerDirection !== undefined) {
      args.triggerDirection = orderParams.triggerDirection;
    }

    return args;
  }

  public async fetchPosition(
    symbol: string,
    marketType: MarketTypeEnum
  ): Promise<Position | null> {
    try {
      const position = await this.getClient(marketType).fetchPosition(symbol);

      return position;
    } catch (error) {
      logger.error(
        { error, symbol, exchange: this.exchangeName },
        'Failed to fetch position'
      );

      return null;
    }
  }

  public async setLeverage(
    symbol: string,
    leverage: number
  ): Promise<boolean> {
    try {
      await this.exchange.futures.setLeverage(leverage, symbol);

      return true;
    } catch {
      return false;
    }
  }

  public async setMarginMode(
    symbol: string,
    marginMode: MarginModeEnum
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

      const filteredSymbolList = [...tradeSymbols.values()]
        .filter(m => m.isActive && (m.type === TradeSymbolTypeEnum.Swap || m.type === TradeSymbolTypeEnum.Future) && m.isLinear)
        .map(m =>
          this.exchangeName === ExchangeNameEnum.Bybit ? normalizeSymbol(m.symbol) : m.symbol
        );

      logger.info(
        {
          exchange: this.exchangeName,
          futuresCount: filteredSymbolList.length,
          sampleSymbols: filteredSymbolList.slice(0, 5),
        },
        'Futures symbols filtered'
      );

      return filteredSymbolList;
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

      const filteredSymbolList = [...tradeSymbols.values()]
        .filter(m => m.isActive && m.type === TradeSymbolTypeEnum.Spot)
        .map(m =>
          this.exchangeName === ExchangeNameEnum.Bybit ? normalizeSymbol(m.symbol) : m.symbol
        );

      logger.info(
        {
          exchange: this.exchangeName,
          spotCount: filteredSymbolList.length,
          sampleSymbols: filteredSymbolList.slice(0, 5),
        },
        'Spot symbols filtered'
      );

      return filteredSymbolList;
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to get spot symbols'
      );

      return [];
    }
  }

  public getClient(marketType: MarketTypeEnum): ExchangeClient {
    return isSpot(marketType) ? this.exchange.spot : this.exchange.futures;
  }

  public getExchangeName(): ExchangeNameEnum {
    return this.exchangeName;
  }

  public isTradeWebSocketConnected(marketType: MarketTypeEnum): boolean {
    return this.getClient(marketType).isTradeWebSocketConnected();
  }

  public async connectTradeWebSocket(marketType: MarketTypeEnum): Promise<void> {
    await this.getClient(marketType).connectTradeWebSocket();
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

  public getWebSocketConnectionInfoList(): WebSocketConnectionInfo[] {
    try {
      return this.exchange.getWebSocketConnectionInfoList();
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to get WebSocket connection info list'
      );

      return [];
    }
  }

  public async fetchBalance(
    marketType: MarketTypeEnum
  ): Promise<BalanceByAsset | null> {
    try {
      return await this.getClient(marketType).fetchBalance();
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName, marketType },
        'Failed to fetch balance'
      );

      return null;
    }
  }

  public async fetchOrderHistory(
    symbol: string,
    marketType: MarketTypeEnum,
    options?: FetchPageWithLimitArgs
  ): Promise<Order[]> {
    try {
      return await this.getClient(marketType).fetchOrderHistory(
        symbol,
        options
      );
    } catch (error) {
      logger.error(
        { error, symbol, exchange: this.exchangeName, marketType },
        'Failed to fetch order history'
      );

      return [];
    }
  }

  public getMinOrderQty(
    symbol: string,
    marketType: MarketTypeEnum
  ): number {
    try {
      return this.getClient(marketType).getMinOrderQty(symbol);
    } catch (error) {
      logger.error(
        { error, symbol, exchange: this.exchangeName, marketType },
        'Failed to get min order qty'
      );

      return 0;
    }
  }

  public getMinNotional(
    symbol: string,
    marketType: MarketTypeEnum
  ): number {
    try {
      return this.getClient(marketType).getMinNotional(symbol);
    } catch (error) {
      logger.error(
        { error, symbol, exchange: this.exchangeName, marketType },
        'Failed to get min notional'
      );

      return 0;
    }
  }

  public async fetchPositionMode(): Promise<PositionModeEnum | null> {
    try {
      return await this.exchange.futures.fetchPositionMode();
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to fetch position mode'
      );

      return null;
    }
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
