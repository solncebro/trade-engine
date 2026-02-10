import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import ccxt, { Exchange, Ticker, Tickers } from 'ccxt';

import {
  BybitNativeTradeWebSocket,
  BybitOrderParams,
} from './bybitNativeTradeWebSocket';
import { TelegramNotifier } from './telegramNotifier';

import { BYBIT_RECV_WINDOW } from '../constants/bybit';
import { logger } from '../core/logger';
import {
  CreateBybitErrorResultArgs,
  ExchangeConfig,
  ExchangeErrorInfo,
  ExchangeName,
  MarketInfo,
  MarketType,
  OrderParams,
  OrderResult,
  OrderType,
  PositionInfo,
  PositionWithTypedInfo,
  TimeInForce,
} from '../types';
import { isSpot } from '../utils/order.utils';
import { normalizeSymbol } from '../utils/symbol.utils';

export class ExchangeConnector extends EventEmitter {
  private exchange: Exchange;
  private spotExchange: Exchange | null = null;
  private exchangeName: ExchangeName;
  private config: ExchangeConfig;
  private tickerDataMap: Map<string, Ticker> = new Map();
  private isWatchingTickers: boolean = false;
  private tickerUpdateIntervalId: NodeJS.Timeout | null = null;
  private bybitNativeTradeWebSocket: BybitNativeTradeWebSocket | null = null;

  constructor(
    exchangeName: ExchangeName,
    config: ExchangeConfig,
    telegramNotifier?: TelegramNotifier
  ) {
    super();
    this.exchangeName = exchangeName;
    this.config = config;

    const ExchangeClass = this.getExchangeClass(exchangeName);

    const baseOptions: Record<string, unknown> = {
      defaultType: exchangeName === 'bybit' ? 'swap' : 'future',
    };

    if (exchangeName === 'bybit') {
      baseOptions.recvWindow = BYBIT_RECV_WINDOW;
    }

    this.exchange = new ExchangeClass({
      apiKey: config.apiKey,
      secret: config.secret,
      sandbox: false,
      testnet: false,
      options: baseOptions,
    });

    if (exchangeName === 'bybit') {
      this.bybitNativeTradeWebSocket = new BybitNativeTradeWebSocket(
        config,
        telegramNotifier
      );
    }
  }

  private getSpotExchange(): Exchange {
    if (!this.spotExchange) {
      const ExchangeClass = this.getExchangeClass(this.exchangeName);

      const spotOptions: Record<string, unknown> = {
        defaultType: 'spot',
      };

      if (this.exchangeName === 'bybit') {
        spotOptions.recvWindow = BYBIT_RECV_WINDOW;
      }

      this.spotExchange = new ExchangeClass({
        apiKey: this.config.apiKey,
        secret: this.config.secret,
        sandbox: false,
        testnet: false,
        options: spotOptions,
      });
    }

    return this.spotExchange;
  }

  private getExchangeClass(exchangeName: ExchangeName): typeof Exchange {
    switch (exchangeName) {
      case 'binance':
        return ccxt.binance;
      case 'bybit':
        return ccxt.bybit;
      default:
        throw new Error(`Unsupported exchange: ${exchangeName}`);
    }
  }

  private getDetailedErrorInfo(error: unknown): ExchangeErrorInfo {
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;
      const errorInfo: ExchangeErrorInfo = {
        name: typeof err.name === 'string' ? err.name : 'Unknown',
        message: typeof err.message === 'string' ? err.message : 'No message',
      };

      if (err.code) {
        errorInfo.code = err.code as string | number;
      }

      if (err.response) {
        errorInfo.response = err.response;
      }

      if (typeof err.status === 'number') {
        errorInfo.status = err.status;
      }

      if (typeof err.statusText === 'string') {
        errorInfo.statusText = err.statusText;
      }

      return errorInfo;
    }

    return {
      name: 'Unknown',
      message: String(error),
    };
  }

  public async initialize(): Promise<void> {
    try {
      await this.exchange.loadMarkets();

      if (this.bybitNativeTradeWebSocket) {
        try {
          await this.bybitNativeTradeWebSocket.connect();
        } catch (error) {
          logger.error(
            {
              error: this.getDetailedErrorInfo(error),
              exchange: this.exchangeName,
            },
            'Failed to connect Bybit native WebSocket'
          );
          throw error;
        }
      }

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

    if (this.exchangeName === 'binance') {
      this.startBinanceTickerUpdates();
      logger.info('Started Binance watching tickers via WebSocket');
    } else if (this.exchangeName === 'bybit') {
      this.startBybitTickerUpdates();
      logger.info(
        'Started Bybit watching tickers via REST API (updates every 30 seconds)'
      );
    }
  }

  private processTickerList(
    tickers: Tickers,
    marketType: MarketType = MarketType.Futures
  ): void {
    const tickerEntries = Object.entries(tickers);

    tickerEntries.forEach(([symbol, ticker]) => {
      const normalizedSymbol = normalizeSymbol(symbol);
      const tickerKey = this.getTickerKey(normalizedSymbol, marketType);

      if (ticker.close !== undefined) {
        this.tickerDataMap.set(tickerKey, ticker);
      }
    });
  }

  private getTickerKey(symbol: string, marketType?: MarketType): string {
    const type = marketType ?? MarketType.Futures;

    return `${type}:${symbol}`;
  }

  private async startBinanceTickerUpdates(): Promise<void> {
    if (!this.isWatchingTickers) {
      return;
    }

    logger.info('Starting Binance ticker WebSocket connection');

    while (this.isWatchingTickers) {
      try {
        const spotExchange = this.getSpotExchange();

        const [futuresTickerList, spotTickerList] = await Promise.all([
          this.exchange.watchTickers(),
          spotExchange.watchTickers(),
        ]);

        this.processTickerList(futuresTickerList, MarketType.Futures);
        this.processTickerList(spotTickerList, MarketType.Spot);
      } catch (error) {
        logger.error(
          { error, exchange: this.exchangeName },
          'Error watching Binance tickers'
        );

        if (this.isWatchingTickers) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
  }

  private async startBybitTickerUpdates(): Promise<void> {
    const updateInterval = 30000;

    const updateTickers = async () => {
      if (!this.isWatchingTickers) {
        return;
      }

      try {
        const futuresTickers = await this.exchange.fetchTickers();
        this.processTickerList(futuresTickers, MarketType.Futures);

        const spotExchange = this.getSpotExchange();
        await spotExchange.loadMarkets();
        const spotTickers = await spotExchange.fetchTickers();
        this.processTickerList(spotTickers, MarketType.Spot);
      } catch (error) {
        logger.warn(
          { error, exchange: this.exchangeName },
          'Failed to update Bybit tickers'
        );
      }
    };

    await updateTickers();

    this.tickerUpdateIntervalId = setInterval(async () => {
      if (this.isWatchingTickers) {
        await updateTickers();
      } else {
        if (this.tickerUpdateIntervalId) {
          clearInterval(this.tickerUpdateIntervalId);
          this.tickerUpdateIntervalId = null;
        }
      }
    }, updateInterval);
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

    try {
      if (
        this.exchangeName === 'bybit' &&
        this.bybitNativeTradeWebSocket?.isConnected()
      ) {
        return await this.createBybitNativeOrder(orderParams);
      }

      const fullOrderParams = {
        ...orderParams,
        params: this.getOrderParams(orderParams.type, orderParams.marketType),
      };

      const order = await this.exchange.createOrderWs(
        fullOrderParams.symbol,
        fullOrderParams.type,
        fullOrderParams.side,
        fullOrderParams.amount,
        fullOrderParams.price,
        fullOrderParams.params
      );

      return {
        ...resultBase,
        orderId: order.id,
        actualExchangeParams: fullOrderParams,
        responseData: {
          ...order,
          orderId: order.id,
        },
      };
    } catch (error) {
      logger.error(
        { error, orderParams, exchange: this.exchangeName },
        'Failed to create order'
      );

      return {
        ...resultBase,
        errorText: error instanceof Error ? error.message : 'Unknown error',
        actualExchangeParams: undefined,
      };
    }
  }

  private getOrderParams(
    orderType: OrderType,
    marketType?: MarketType
  ): Record<string, unknown> {
    if (isSpot(marketType)) {
      return {};
    }

    const baseParams = { hedgeMode: true };

    if (orderType === 'limit') {
      return { ...baseParams, reduceOnly: true };
    }

    return baseParams;
  }

  private capitalizeOrderType(type: OrderType): 'Market' | 'Limit' {
    return (type.charAt(0).toUpperCase() + type.slice(1)) as 'Market' | 'Limit';
  }

  private createBybitErrorResult(
    args: CreateBybitErrorResultArgs
  ): OrderResult {
    const dataErrorText = args.response.data?.errorText;
    const errorText = dataErrorText
      ? dataErrorText
      : `${args.prefix ? `${args.prefix}: ` : ''}${args.response.retCode ?? 'Unknown'}: ${args.response.retMsg ?? 'Unknown error'}`;

    return {
      ...args.resultBase,
      errorText,
      actualExchangeParams: args.actualExchangeParams,
    };
  }

  private async createBybitNativeOrder(
    orderParams: OrderParams
  ): Promise<OrderResult> {
    if (!this.bybitNativeTradeWebSocket) {
      throw new Error('Bybit native WebSocket not initialized');
    }

    const {
      symbol,
      amount,
      side,
      type,
      price,
      triggerPrice,
      triggerDirection,
      params,
      marketType,
    } = orderParams;

    const normalizedQty = this.exchange.amountToPrecision(symbol, amount);
    const category = isSpot(marketType) ? 'spot' : 'linear';

    const bybitOrderParams: BybitOrderParams = {
      symbol,
      side: side === 'buy' ? 'Buy' : 'Sell',
      orderType: this.capitalizeOrderType(type),
      qty: normalizedQty,
      category,
      timeInForce:
        type === OrderType.Market ? TimeInForce.IOC : TimeInForce.GTC,
    };

    logger.info(
      {
        originalParams: orderParams,
        bybitOrderParams,
        normalizedQty,
      },
      'Creating Bybit native order'
    );

    if (type === OrderType.Limit) {
      bybitOrderParams.price = this.exchange.priceToPrecision(symbol, price);
    }

    if (triggerPrice !== undefined) {
      bybitOrderParams.triggerPrice = this.exchange.priceToPrecision(
        symbol,
        triggerPrice
      );
    }

    if (triggerDirection !== undefined) {
      bybitOrderParams.triggerDirection = triggerDirection;
    }

    if (!isSpot(marketType) && params?.reduceOnly) {
      bybitOrderParams.reduceOnly = true;
    }

    const response =
      await this.bybitNativeTradeWebSocket.createOrder(bybitOrderParams);

    const resultBase = {
      exchangeName: this.exchangeName,
      orderParams,
      actualExchangeParams: bybitOrderParams,
    };

    if (response.retCode === 0 && response.data && !response.data.errorText) {
      return {
        ...resultBase,
        orderId: response.data.orderId as string,
        responseData: response.data,
      };
    }

    return this.createBybitErrorResult({
      resultBase,
      response,
      actualExchangeParams: bybitOrderParams,
    });
  }

  public async fetchPosition(
    symbol: string
  ): Promise<PositionWithTypedInfo<PositionInfo> | null> {
    try {
      const position = await this.exchange.fetchPosition(symbol);

      return position as PositionWithTypedInfo<PositionInfo>;
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
      await this.exchange.setLeverage(leverage, symbol);

      return true;
    } catch {
      return false;
    }
  }

  public async setMarginMode(
    symbol: string,
    marginMode: 'isolated' | 'cross'
  ): Promise<boolean> {
    try {
      await this.exchange.setMarginMode(marginMode, symbol);

      return true;
    } catch {
      return false;
    }
  }

  private async getSymbolsByFilter(
    filterFn: (market: MarketInfo) => boolean,
    logData: {
      countKey: string;
      logMessage: string;
      errorMessage: string;
    },
    exchangeInstance?: Exchange
  ): Promise<string[]> {
    try {
      const exchange = exchangeInstance ?? this.exchange;

      if (Object.keys(exchange.markets).length === 0) {
        await exchange.loadMarkets(true);
      }

      const marketList = Object.values(exchange.markets) as MarketInfo[];
      const filteredMarketList = marketList.filter(filterFn);

      logger.info(
        {
          exchange: this.exchangeName,
          [logData.countKey]: filteredMarketList.length,
          sampleSymbols: filteredMarketList
            .slice(0, 5)
            .map(market => market.symbol),
        },
        logData.logMessage
      );

      return filteredMarketList.map(market =>
        this.exchangeName === 'bybit'
          ? normalizeSymbol(market.symbol)
          : market.symbol
      );
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        logData.errorMessage
      );

      return [];
    }
  }

  public async getFuturesSymbols(): Promise<string[]> {
    return this.getSymbolsByFilter(
      (market: MarketInfo): boolean => {
        const isFuture = market.type === 'future' || market.type === 'swap';
        const isActive = market.active ?? false;
        const hasLinear =
          this.exchangeName === 'bybit'
            ? Boolean(
                ('linear' in market && market.linear === true) ||
                  ('settle' in market && market.settle === 'USDT')
              )
            : true;

        return isFuture && isActive && hasLinear;
      },
      {
        countKey: 'futuresCount',
        logMessage: 'Futures symbols filtered',
        errorMessage: 'Failed to get futures symbols',
      }
    );
  }

  public async getSpotSymbols(): Promise<string[]> {
    const spotExchange = this.getSpotExchange();

    return this.getSymbolsByFilter(
      (market: MarketInfo): boolean => {
        const isSpot = market.type === 'spot';
        const isActive = market.active ?? false;

        return isSpot && isActive;
      },
      {
        countKey: 'spotCount',
        logMessage: 'Spot symbols filtered',
        errorMessage: 'Failed to get spot symbols',
      },
      spotExchange
    );
  }

  public getExchangeName(): ExchangeName {
    return this.exchangeName;
  }

  public getAccountId(): string {
    if (!this.exchange.apiKey) {
      logger.warn('No API key available to generate account ID');

      return 'default';
    }

    const hash = crypto
      .createHash('sha256')
      .update(this.exchange.apiKey)
      .digest('hex');

    return hash.substring(0, 16);
  }

  public isTradeWebSocketConnected(): boolean {
    return this.bybitNativeTradeWebSocket?.isConnected() ?? false;
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

    if (this.bybitNativeTradeWebSocket) {
      this.bybitNativeTradeWebSocket.disconnect();
      logger.info(
        { exchange: this.exchangeName },
        'Bybit native WebSocket disconnected'
      );
    }

    if (this.spotExchange) {
      try {
        await this.spotExchange.close();
        logger.info(
          { exchange: this.exchangeName },
          'Spot exchange connection closed'
        );
      } catch (error) {
        logger.error(
          { error, exchange: this.exchangeName },
          'Error closing spot exchange connection'
        );
      }
    }

    if (this.exchange) {
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
}
