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
  OrderParams,
  OrderResult,
  OrderType,
  TimeInForce,
} from '../types';
import { normalizeSymbol } from '../utils/symbol.utils';

export class ExchangeConnector extends EventEmitter {
  private exchange: Exchange;
  private exchangeName: ExchangeName;
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

  private processTickerList(tickers: Tickers): void {
    const tickerEntries = Object.entries(tickers);

    tickerEntries.forEach(([symbol, ticker]) => {
      const normalizedSymbol = normalizeSymbol(symbol);

      if (ticker.close !== undefined) {
        this.tickerDataMap.set(normalizedSymbol, ticker);
      }
    });
  }

  private async startBinanceTickerUpdates(): Promise<void> {
    if (!this.isWatchingTickers) {
      return;
    }

    logger.info('Starting Binance ticker WebSocket connection');

    while (this.isWatchingTickers) {
      try {
        const tickerList = await this.exchange.watchTickers();
        this.processTickerList(tickerList);
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
        const tickers = await this.exchange.fetchTickers();
        this.processTickerList(tickers);
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

  public resolveSymbolWithPrefix(symbol: string): string {
    if (this.tickerDataMap.has(symbol)) {
      return symbol;
    }

    for (const prefix of this.SYMBOL_PREFIX_LIST) {
      const prefixedSymbol = `${prefix}${symbol}`;

      if (this.tickerDataMap.has(prefixedSymbol)) {
        logger.info(
          {
            originalSymbol: symbol,
            resolvedSymbol: prefixedSymbol,
            exchange: this.exchangeName,
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
        testedPrefixes: this.SYMBOL_PREFIX_LIST,
      },
      'Symbol not found with any prefix'
    );

    return symbol;
  }

  public getTicker(symbol: string): Ticker | undefined {
    return this.tickerDataMap.get(symbol);
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
        params: this.getOrderParams(orderParams.type),
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

  private getOrderParams(orderType: OrderType): Record<string, unknown> {
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
    const errorText = `${args.prefix ? `${args.prefix}: ` : ''}${args.response.retCode ?? 'Unknown'}: ${args.response.retMsg ?? 'Unknown error'}`;

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

    const { symbol, amount, side, type, price, params } = orderParams;

    const normalizedQty = this.exchange.amountToPrecision(symbol, amount);

    const bybitOrderParams: BybitOrderParams = {
      symbol,
      side: side === 'buy' ? 'Buy' : 'Sell',
      orderType: this.capitalizeOrderType(type),
      qty: normalizedQty,
      category: 'linear',
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

    if (type.toLowerCase() === OrderType.Limit.toLowerCase()) {
      bybitOrderParams.price = this.exchange.priceToPrecision(symbol, price);
    }

    if (params?.reduceOnly) {
      bybitOrderParams.reduceOnly = true;
    }

    const response =
      await this.bybitNativeTradeWebSocket.createOrder(bybitOrderParams);

    const resultBase = {
      exchangeName: this.exchangeName,
      orderParams,
      actualExchangeParams: bybitOrderParams,
    };

    if (response.retCode === 0 && response.data) {
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

  public async getFuturesSymbols(): Promise<string[]> {
    try {
      if (Object.keys(this.exchange.markets).length === 0) {
        await this.exchange.loadMarkets();
      }

      const marketList = Object.values(this.exchange.markets) as MarketInfo[];
      logger.info(
        {
          exchange: this.exchangeName,
          totalMarkets: marketList.length,
          marketTypes: [...new Set(marketList.map(market => market.type))],
        },
        'Market data loaded'
      );

      const futureMarketList = marketList.filter((market: MarketInfo) => {
        const isFuture = market.type === 'future' || market.type === 'swap';
        const isActive = market.active;
        const hasLinear =
          this.exchangeName === 'bybit'
            ? ('linear' in market && market.linear === true) ||
              ('settle' in market && market.settle === 'USDT')
            : true;

        return isFuture && isActive && hasLinear;
      });

      logger.info(
        {
          exchange: this.exchangeName,
          futuresCount: futureMarketList.length,
          sampleSymbols: futureMarketList
            .slice(0, 5)
            .map(market => market.symbol),
        },
        'Futures symbols filtered'
      );

      return futureMarketList.map(market =>
        this.exchangeName === 'bybit'
          ? normalizeSymbol(market.symbol)
          : market.symbol
      );
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to get futures symbols'
      );

      return [];
    }
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
