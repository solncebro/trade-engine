import * as crypto from 'crypto';

import { ExchangeError, Exchange as ExchangeInstance, ExchangeNameEnum, OrderSideEnum, PositionModeEnum, PositionSideEnum, TimeInForceEnum, TradeSymbolTypeEnum } from '@solncebro/exchange-engine';
import type { CreateOrderWebSocketArgs, ExchangeClient, KlineHandler, MarkPriceHandler, MarkPriceUpdate, OrderBookHandler, OrderRateLimit, PublicTradeHandler, SubscribeKlinesArgs, SubscribeOrderbookArgs, SubscribePublicTradesArgs, Ticker, TickerBySymbol } from '@solncebro/exchange-engine';

import { KlineSubscriptionWatchdog } from './klineSubscriptionWatchdog';
import type { KlineSubscriptionWatchdogConfig } from './klineSubscriptionWatchdog.types';
import { StreamSubscriptionWatchdog } from './streamSubscriptionWatchdog';
import type { StreamHealthEvent, StreamSubscriptionWatchdogConfig, StreamWatchdogCallbacks } from './streamSubscriptionWatchdog.types';
import {
  buildOrderbookWatchdogKey,
  buildPublicTradeWatchdogKey,
  MARK_PRICE_WATCHDOG_KEY,
  MarkPriceWatchdogStrategy,
  OrderbookWatchdogStrategy,
  PublicTradeWatchdogStrategy,
} from './streamWatchdogStrategies';

import { logger } from '../core/logger';
import { PositionManager } from '../core/positionManager';
import { RateLimitedRequestQueue } from '../core/RateLimitedRequestQueue';
import { withReadRetry } from '../core/withRetryOn429';
import {
  ExchangeConfig,
  MarketTypeEnum,
  OrderParams,
  OrderResult,
  OrderTypeEnum,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isSpot } from '../utils/order.utils';
import { configurePriceTickSnapper } from '../utils/priceFormat';
import { normalizeSymbol } from '../utils/symbol.utils';

export interface RateLimitConfig {
  writeRequestsPerSecond: number;
  intervalMs?: number;
}

// Per-stream watchdog config for the non-kline public streams. Each stream type
// is OFF by default (isEnabled must be set true to activate), so publishing the
// library changes nothing until a consumer opts in. Health-event callbacks are
// invoked with the marketType injected by ExchangeConnector (the watchdog itself
// is per-marketType and stream-type-agnostic).
export interface StreamWatchdogStreamConfig extends StreamSubscriptionWatchdogConfig {
  onStale?: (marketType: MarketTypeEnum, event: StreamHealthEvent) => void;
  onRecovered?: (marketType: MarketTypeEnum, event: StreamHealthEvent) => void;
  onRecoveryFailed?: (marketType: MarketTypeEnum, event: StreamHealthEvent) => void;
  onNotify?: (message: string) => void | Promise<void>;
}

export interface StreamWatchdogConfigMap {
  orderbook?: StreamWatchdogStreamConfig;
  publicTrade?: StreamWatchdogStreamConfig;
  markPrice?: StreamWatchdogStreamConfig;
}

interface StreamWatchdogBundle {
  kline: KlineSubscriptionWatchdog | null;
  orderbook: StreamSubscriptionWatchdog | null;
  publicTrade: StreamSubscriptionWatchdog | null;
  markPrice: StreamSubscriptionWatchdog | null;
}

const FALLBACK_WRITE_REQUESTS_PER_SECOND = 10;

// Min gap between on-demand full futures trade-symbol reloads (triggered by a missing
// symbol). Trade symbols load once at initialize(); a symbol listed afterwards is absent
// until reloaded. This cooldown guards the instruments-info REST endpoint from being
// hammered when a chaser is created for a symbol that genuinely does not exist.
const FUTURES_TRADE_SYMBOLS_RELOAD_COOLDOWN_MS = 60_000;

function readReduceOnly(orderParams: OrderParams): boolean {
  if (orderParams.reduceOnly === true) {
    return true;
  }
  if (orderParams.params && (orderParams.params as { reduceOnly?: unknown }).reduceOnly === true) {
    return true;
  }
  return false;
}

function inferHedgePositionSide(side: OrderSideEnum, isReduceOnly: boolean): PositionSideEnum {
  if (isReduceOnly) {
    return side === OrderSideEnum.Sell ? PositionSideEnum.Long : PositionSideEnum.Short;
  }
  return side === OrderSideEnum.Buy ? PositionSideEnum.Long : PositionSideEnum.Short;
}

export class ExchangeConnector {
  private exchange: ExchangeInstance;
  private exchangeName: ExchangeNameEnum;
  private tickersByMarketTypeAndSymbol: Map<string, Ticker> = new Map();
  private isWatchingTickers: boolean = false;
  private isUpdatingTickers: boolean = false;
  private tickerUpdateIntervalId: NodeJS.Timeout | null = null;
  private markPriceByFuturesSymbol: Map<string, MarkPriceUpdate> = new Map();
  private isWatchingMarkPrices: boolean = false;
  private _positionManager: PositionManager | null = null;
  public readonly futuresPositionMode: PositionModeEnum;

  private readonly futuresStreamBundle: StreamWatchdogBundle;
  private readonly spotStreamBundle: StreamWatchdogBundle;
  private _futuresProxy: ExchangeClient | null = null;
  private _spotProxy: ExchangeClient | null = null;
  private readonly rateLimitConfigOverride: RateLimitConfig | null | undefined;
  private writeQueue: RateLimitedRequestQueue | null = null;

  // On-demand futures trade-symbol reload state: a shared in-flight promise so concurrent
  // callers join one REST round-trip, plus the last reload timestamp for the cooldown.
  private futuresTradeSymbolsReloadInFlight: Promise<void> | null = null;
  private lastFuturesTradeSymbolsReloadMs: number = 0;

  private readonly markPriceHandler = (list: MarkPriceUpdate[]): void => {
    for (const update of list) {
      if (!Number.isFinite(update.markPrice) || update.markPrice <= 0) {
        continue;
      }
      this.markPriceByFuturesSymbol.set(update.symbol, update);
    }
  };

  constructor(
    exchangeName: ExchangeNameEnum,
    config: ExchangeConfig,
    onNotify?: (message: string) => void | Promise<void>,
    futuresPositionMode: PositionModeEnum = PositionModeEnum.OneWay,
    klineWatchdogConfig?: KlineSubscriptionWatchdogConfig,
    rateLimitConfig?: RateLimitConfig | null,
    streamWatchdogConfig?: StreamWatchdogConfigMap
  ) {
    this.exchangeName = exchangeName;
    this.futuresPositionMode = futuresPositionMode;
    this.rateLimitConfigOverride = rateLimitConfig;

    this.exchange = new ExchangeInstance(exchangeName, {
      config,
      logger,
      onNotify,
    });

    const exchangeLabel = exchangeName.charAt(0).toUpperCase() + exchangeName.slice(1);

    this.futuresStreamBundle = this.buildStreamBundle(
      MarketTypeEnum.Futures,
      this.exchange.futures,
      `${exchangeLabel} Futures`,
      klineWatchdogConfig,
      streamWatchdogConfig,
      onNotify
    );
    this.spotStreamBundle = this.buildStreamBundle(
      MarketTypeEnum.Spot,
      this.exchange.spot,
      `${exchangeLabel} Spot`,
      klineWatchdogConfig,
      streamWatchdogConfig,
      onNotify
    );

    this.startStreamBundle(this.futuresStreamBundle);
    this.startStreamBundle(this.spotStreamBundle);
  }

  private buildStreamBundle(
    marketType: MarketTypeEnum,
    client: ExchangeClient,
    clientLabel: string,
    klineWatchdogConfig: KlineSubscriptionWatchdogConfig | undefined,
    streamWatchdogConfig: StreamWatchdogConfigMap | undefined,
    onNotify: ((message: string) => void | Promise<void>) | undefined
  ): StreamWatchdogBundle {
    // Kline watchdog stays ON by default (preserves pre-existing behaviour).
    const kline = klineWatchdogConfig?.isEnabled !== false
      ? new KlineSubscriptionWatchdog({ client, clientLabel, config: klineWatchdogConfig, onNotify })
      : null;

    const orderbook = streamWatchdogConfig?.orderbook?.isEnabled === true
      ? new StreamSubscriptionWatchdog({
        clientLabel,
        strategy: new OrderbookWatchdogStrategy(client, clientLabel),
        config: streamWatchdogConfig.orderbook,
        callbacks: this.buildStreamCallbacks(marketType, streamWatchdogConfig.orderbook, onNotify),
      })
      : null;

    const publicTrade = streamWatchdogConfig?.publicTrade?.isEnabled === true
      ? new StreamSubscriptionWatchdog({
        clientLabel,
        strategy: new PublicTradeWatchdogStrategy(client, clientLabel),
        config: streamWatchdogConfig.publicTrade,
        callbacks: this.buildStreamCallbacks(marketType, streamWatchdogConfig.publicTrade, onNotify),
      })
      : null;

    // Mark price exists only on the futures stream (Bybit has no spot mark price).
    const markPrice = marketType === MarketTypeEnum.Futures && streamWatchdogConfig?.markPrice?.isEnabled === true
      ? new StreamSubscriptionWatchdog({
        clientLabel,
        strategy: new MarkPriceWatchdogStrategy(client, clientLabel),
        config: streamWatchdogConfig.markPrice,
        callbacks: this.buildStreamCallbacks(marketType, streamWatchdogConfig.markPrice, onNotify),
      })
      : null;

    return { kline, orderbook, publicTrade, markPrice };
  }

  private buildStreamCallbacks(
    marketType: MarketTypeEnum,
    streamConfig: StreamWatchdogStreamConfig,
    onNotify: ((message: string) => void | Promise<void>) | undefined
  ): StreamWatchdogCallbacks {
    return {
      onNotify: streamConfig.onNotify ?? onNotify,
      onStreamStale: (event: StreamHealthEvent): void => streamConfig.onStale?.(marketType, event),
      onStreamRecovered: (event: StreamHealthEvent): void => streamConfig.onRecovered?.(marketType, event),
      onStreamRecoveryFailed: (event: StreamHealthEvent): void => streamConfig.onRecoveryFailed?.(marketType, event),
    };
  }

  private startStreamBundle(bundle: StreamWatchdogBundle): void {
    bundle.kline?.start();
    bundle.orderbook?.start();
    bundle.publicTrade?.start();
    bundle.markPrice?.start();
  }

  private stopStreamBundle(bundle: StreamWatchdogBundle): void {
    bundle.kline?.stop();
    bundle.orderbook?.stop();
    bundle.publicTrade?.stop();
    bundle.markPrice?.stop();
  }

  private hasAnyWatchdog(bundle: StreamWatchdogBundle): boolean {
    return bundle.kline !== null || bundle.orderbook !== null || bundle.publicTrade !== null || bundle.markPrice !== null;
  }

  public get spot(): ExchangeClient {
    if (!this.hasAnyWatchdog(this.spotStreamBundle)) {
      return this.exchange.spot;
    }

    if (this._spotProxy === null) {
      this._spotProxy = this.createWatchdogClientProxy(this.exchange.spot, this.spotStreamBundle);
    }

    return this._spotProxy;
  }

  public get futures(): ExchangeClient {
    if (!this.hasAnyWatchdog(this.futuresStreamBundle)) {
      return this.exchange.futures;
    }

    if (this._futuresProxy === null) {
      this._futuresProxy = this.createWatchdogClientProxy(this.exchange.futures, this.futuresStreamBundle);
    }

    return this._futuresProxy;
  }

  // Wraps subscribe*/unsubscribe* so every enabled watchdog sees handler activity.
  // For the heartbeat streams (orderbook/publicTrade/markPrice) the wrapped handler
  // ref is tracked per original handler so unsubscribe removes the SAME ref the
  // underlying stream stored by-reference (otherwise the topic would leak). Kline
  // wrapping is left exactly as before for back-compat.
  private createWatchdogClientProxy(client: ExchangeClient, bundle: StreamWatchdogBundle): ExchangeClient {
    // Wrapped-handler refs are keyed by the watchdog KEY (topic-unique), not by the
    // original handler, because a consumer may share one handler ref across many
    // symbols (coin-listing does). Keying by handler would overwrite and leak every
    // topic but the last on unsubscribe.
    const klineWrappedByKey = new Map<string, KlineHandler>();
    const orderbookWrappedByKey = new Map<string, OrderBookHandler>();
    const publicTradeWrappedByKey = new Map<string, PublicTradeHandler>();
    const markPriceWrappedByKey = new Map<string, MarkPriceHandler>();

    return new Proxy(client, {
      get(target, prop): unknown {
        const klineWatchdog = bundle.kline;

        if (klineWatchdog !== null && prop === 'subscribeKlines') {
          return (args: SubscribeKlinesArgs): void => {
            const key = `${args.symbol}_${args.interval}`;
            const wrappedHandler = klineWatchdog.wrapHandler(args.symbol, args.interval, args.handler);
            klineWrappedByKey.set(key, wrappedHandler);
            target.subscribeKlines({ symbol: args.symbol, interval: args.interval, handler: wrappedHandler });
          };
        }

        if (klineWatchdog !== null && prop === 'unsubscribeKlines') {
          return (args: SubscribeKlinesArgs): void => {
            const key = `${args.symbol}_${args.interval}`;
            klineWatchdog.unregisterHandler(args.symbol, args.interval);
            // Pass the SAME wrapped ref that subscribe registered — the underlying
            // stream stores handlers by reference, so unsubscribing with the original
            // (unwrapped) handler would silently leave the topic subscribed (leak).
            const wrapped = klineWrappedByKey.get(key) ?? args.handler;
            klineWrappedByKey.delete(key);
            target.unsubscribeKlines({ symbol: args.symbol, interval: args.interval, handler: wrapped });
          };
        }

        const orderbookWatchdog = bundle.orderbook;

        if (orderbookWatchdog !== null && prop === 'subscribeOrderbook') {
          return (args: SubscribeOrderbookArgs): void => {
            const key = buildOrderbookWatchdogKey(args.symbol, args.depth);
            orderbookWatchdog.registerKey(key);
            const wrapped: OrderBookHandler = (symbol: string, update): void => {
              orderbookWatchdog.recordFreshness(key, Date.now());

              if (orderbookWatchdog.isSuppressed(key)) {
                return;
              }

              args.handler(symbol, update);
            };
            orderbookWrappedByKey.set(key, wrapped);
            target.subscribeOrderbook({ symbol: args.symbol, depth: args.depth, handler: wrapped });
          };
        }

        if (orderbookWatchdog !== null && prop === 'unsubscribeOrderbook') {
          return (args: SubscribeOrderbookArgs): void => {
            const key = buildOrderbookWatchdogKey(args.symbol, args.depth);
            orderbookWatchdog.unregisterKey(key);
            const wrapped = orderbookWrappedByKey.get(key) ?? args.handler;
            orderbookWrappedByKey.delete(key);
            target.unsubscribeOrderbook({ symbol: args.symbol, depth: args.depth, handler: wrapped });
          };
        }

        const publicTradeWatchdog = bundle.publicTrade;

        if (publicTradeWatchdog !== null && prop === 'subscribePublicTrades') {
          return (args: SubscribePublicTradesArgs): void => {
            const key = buildPublicTradeWatchdogKey(args.symbol);
            publicTradeWatchdog.registerKey(key);
            const wrapped: PublicTradeHandler = (symbol: string, tradeList): void => {
              publicTradeWatchdog.recordFreshness(key, Date.now());

              if (publicTradeWatchdog.isSuppressed(key)) {
                return;
              }

              args.handler(symbol, tradeList);
            };
            publicTradeWrappedByKey.set(key, wrapped);
            target.subscribePublicTrades({ symbol: args.symbol, handler: wrapped });
          };
        }

        if (publicTradeWatchdog !== null && prop === 'unsubscribePublicTrades') {
          return (args: SubscribePublicTradesArgs): void => {
            const key = buildPublicTradeWatchdogKey(args.symbol);
            publicTradeWatchdog.unregisterKey(key);
            const wrapped = publicTradeWrappedByKey.get(key) ?? args.handler;
            publicTradeWrappedByKey.delete(key);
            target.unsubscribePublicTrades({ symbol: args.symbol, handler: wrapped });
          };
        }

        const markPriceWatchdog = bundle.markPrice;

        if (markPriceWatchdog !== null && prop === 'subscribeMarkPrices') {
          return (handler: MarkPriceHandler): void => {
            markPriceWatchdog.registerKey(MARK_PRICE_WATCHDOG_KEY);
            const wrapped: MarkPriceHandler = (markPriceList): void => {
              markPriceWatchdog.recordFreshness(MARK_PRICE_WATCHDOG_KEY, Date.now());

              if (markPriceWatchdog.isSuppressed(MARK_PRICE_WATCHDOG_KEY)) {
                return;
              }

              handler(markPriceList);
            };
            markPriceWrappedByKey.set(MARK_PRICE_WATCHDOG_KEY, wrapped);
            target.subscribeMarkPrices(wrapped);
          };
        }

        if (markPriceWatchdog !== null && prop === 'unsubscribeMarkPrices') {
          return (handler: MarkPriceHandler): void => {
            markPriceWatchdog.unregisterKey(MARK_PRICE_WATCHDOG_KEY);
            const wrapped = markPriceWrappedByKey.get(MARK_PRICE_WATCHDOG_KEY) ?? handler;
            markPriceWrappedByKey.delete(MARK_PRICE_WATCHDOG_KEY);
            target.unsubscribeMarkPrices(wrapped);
          };
        }

        return Reflect.get(target, prop, target);
      },
    });
  }

  public get positionManager(): PositionManager {
    if (this._positionManager === null) {
      this._positionManager = new PositionManager(this);
    }

    return this._positionManager;
  }

  public getWriteQueue(): RateLimitedRequestQueue | null {
    if (this.rateLimitConfigOverride === null) {
      return null;
    }

    return this.getOrCreateWriteQueue();
  }

  public async initialize(): Promise<void> {
    try {
      await withReadRetry({
        fn: () => this.exchange.futures.loadTradeSymbols(),
        contextLabel: `loadTradeSymbols futures ${this.exchangeName}`,
      });
      await withReadRetry({
        fn: () => this.exchange.spot.loadTradeSymbols(),
        contextLabel: `loadTradeSymbols spot ${this.exchangeName}`,
      });
      await this.resolveWriteQueueOnInitialize();
      this.installPriceTickSnapper();
      this.startWatchingTickers();
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to initialize exchange'
      );

      throw error;
    }
  }

  /**
   * Teach the shared price formatter this exchange's tick grid, so EVERY price the app states
   * (Telegram, alerts, logs, journal) matches what actually rests on the exchange instead of printing
   * a 16-digit floating-point tail. Wired here because the symbol filters have just been loaded — an
   * app gets it for free by initializing a connector. A symbol whose filters are absent keeps its
   * exact value: priceToPrecision would fall back to a blind 8 decimals and mangle sub-cent coins.
   */
  private installPriceTickSnapper(): void {
    configurePriceTickSnapper((symbol, price) =>
      this.exchange.futures.tradeSymbols.has(symbol)
        ? this.exchange.futures.priceToPrecision(symbol, price)
        : this.exchange.spot.tradeSymbols.has(symbol)
          ? this.exchange.spot.priceToPrecision(symbol, price)
          : price
    );
  }

  private async resolveWriteQueueOnInitialize(): Promise<void> {
    if (this.rateLimitConfigOverride === null) {
      logger.info(
        { exchange: this.exchangeName },
        `[ExchangeConnector] ${this.exchangeName} rate-limit override=null — write queue disabled (single-request semantics retained for unit tests)`
      );
      return;
    }

    if (this.rateLimitConfigOverride !== undefined) {
      const intervalMs = this.rateLimitConfigOverride.intervalMs ?? 1000;
      this.writeQueue = new RateLimitedRequestQueue({
        rateLimit: this.rateLimitConfigOverride.writeRequestsPerSecond,
        intervalMs,
        loggerLabel: `[RateLimit:${this.exchangeName}:write]`,
      });
      logger.info(
        {
          exchange: this.exchangeName,
          writeRequestsPerSecond: this.rateLimitConfigOverride.writeRequestsPerSecond,
          intervalMs,
        },
        `[ExchangeConnector] ${this.exchangeName} rate-limit override applied — writeRequestsPerSecond=${this.rateLimitConfigOverride.writeRequestsPerSecond} intervalMs=${intervalMs}`
      );
      return;
    }

    const resolvedRateLimit = await this.resolveDynamicWriteRequestsPerSecond();
    this.writeQueue = new RateLimitedRequestQueue({
      rateLimit: resolvedRateLimit,
      intervalMs: 1000,
      loggerLabel: `[RateLimit:${this.exchangeName}:write]`,
    });
  }

  private async resolveDynamicWriteRequestsPerSecond(): Promise<number> {
    let rateLimit: OrderRateLimit;

    try {
      rateLimit = await this.exchange.futures.getOrderRateLimit();
    } catch (error) {
      logger.warn(
        { error, exchange: this.exchangeName },
        `[ExchangeConnector] ${this.exchangeName} dynamic rate-limit read failed — using fallback ${FALLBACK_WRITE_REQUESTS_PER_SECOND} RPS`
      );
      return FALLBACK_WRITE_REQUESTS_PER_SECOND;
    }

    const effectiveLimit = Math.max(1, Math.floor(rateLimit.writeRequestsPerSecond));
    logger.info(
      {
        exchange: this.exchangeName,
        rateLimit,
        effectiveLimit,
      },
      `[ExchangeConnector] ${this.exchangeName} dynamic write rate-limit: ${effectiveLimit} RPS (source: ${rateLimit.source})`
    );
    return effectiveLimit;
  }

  private getOrCreateWriteQueue(): RateLimitedRequestQueue {
    if (this.writeQueue !== null) {
      return this.writeQueue;
    }

    if (this.rateLimitConfigOverride !== undefined && this.rateLimitConfigOverride !== null) {
      this.writeQueue = new RateLimitedRequestQueue({
        rateLimit: this.rateLimitConfigOverride.writeRequestsPerSecond,
        intervalMs: this.rateLimitConfigOverride.intervalMs ?? 1000,
        loggerLabel: `[RateLimit:${this.exchangeName}:write]`,
      });

      return this.writeQueue;
    }

    // Sync fallback for callers accessing positionManager before initialize() finishes
    // resolveDynamicWriteRequestsPerSecond. The dynamic read is async (calls
    // futures.getOrderRateLimit() on Binance), so we cannot await it here.
    // Initialize() will replace this.writeQueue with the dynamic-read value when ready.
    logger.warn(
      { exchange: this.exchangeName, fallbackRps: FALLBACK_WRITE_REQUESTS_PER_SECOND },
      `[ExchangeConnector] ${this.exchangeName} writeQueue accessed before initialize() completed dynamic rate-limit read — using sync fallback ${FALLBACK_WRITE_REQUESTS_PER_SECOND} RPS`
    );
    this.writeQueue = new RateLimitedRequestQueue({
      rateLimit: FALLBACK_WRITE_REQUESTS_PER_SECOND,
      intervalMs: 1000,
      loggerLabel: `[RateLimit:${this.exchangeName}:write:fallback]`,
    });

    return this.writeQueue;
  }

  private async startWatchingTickers(): Promise<void> {
    if (this.isWatchingTickers) {
      return;
    }

    this.isWatchingTickers = true;
    await this.updateTickers();

    this.tickerUpdateIntervalId = setInterval(async () => {
      if (!this.isWatchingTickers) {
        if (this.tickerUpdateIntervalId !== null) {
          clearInterval(this.tickerUpdateIntervalId);
          this.tickerUpdateIntervalId = null;
        }

        return;
      }

      if (this.isUpdatingTickers) {
        return;
      }

      this.isUpdatingTickers = true;

      try {
        await this.updateTickers();
      } finally {
        this.isUpdatingTickers = false;
      }
    }, 30000).unref();
  }

  private async updateTickers(): Promise<void> {
    try {
      const [futuresTickerBySymbol, spotTickerBySymbol] = await Promise.all([
        withReadRetry({
          fn: () => this.exchange.futures.fetchTickers(),
          contextLabel: `fetchTickers futures ${this.exchangeName}`,
        }),
        withReadRetry({
          fn: () => this.exchange.spot.fetchTickers(),
          contextLabel: `fetchTickers spot ${this.exchangeName}`,
        }),
      ]);
      this.processTickerList(futuresTickerBySymbol, MarketTypeEnum.Futures);
      this.processTickerList(spotTickerBySymbol, MarketTypeEnum.Spot);
    } catch (error) {
      logger.warn({ error }, 'Failed to update tickers');
    }
  }

  private processTickerList(
    tickerBySymbol: TickerBySymbol,
    marketType: MarketTypeEnum
  ): void {
    for (const [symbol, ticker] of tickerBySymbol) {
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

  public startWatchingMarkPrices(): void {
    if (this.isWatchingMarkPrices) {
      return;
    }

    this.isWatchingMarkPrices = true;

    try {
      // Route through the proxied futures getter so the mark-price watchdog (when
      // enabled) wraps this handler; passthrough to the raw client when disabled.
      this.futures.subscribeMarkPrices(this.markPriceHandler);
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to start watching mark prices',
      );
      this.isWatchingMarkPrices = false;
    }
  }

  public stopWatchingMarkPrices(): void {
    if (!this.isWatchingMarkPrices) {
      return;
    }

    this.isWatchingMarkPrices = false;

    try {
      this.futures.unsubscribeMarkPrices(this.markPriceHandler);
    } catch (error) {
      logger.warn(
        { error, exchange: this.exchangeName },
        'Error during mark price unsubscribe',
      );
    }

    this.markPriceByFuturesSymbol.clear();
  }

  public getMarkPrice(symbol: string): MarkPriceUpdate | undefined {
    return this.markPriceByFuturesSymbol.get(symbol);
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

      logger.info(
        {
          exchange: this.exchangeName,
          symbol: wsArgs.symbol,
          side: wsArgs.side,
          type: wsArgs.type,
          marketType: orderParams.marketType,
          amount: wsArgs.amount,
          price: wsArgs.price,
          stopPrice: wsArgs.stopPrice,
          reduceOnly: wsArgs.reduceOnly,
          positionSide: wsArgs.positionSide,
          clientOrderId: wsArgs.clientOrderId,
        },
        `[ExchangeConnector] ${wsArgs.symbol} createOrder request ${wsArgs.side} ${wsArgs.type} amount=${wsArgs.amount}`
      );

      const order = await client.createOrderWebSocket(wsArgs);

      logger.info(
        {
          exchange: this.exchangeName,
          symbol: wsArgs.symbol,
          orderId: order.id,
          amount: wsArgs.amount,
          clientOrderId: wsArgs.clientOrderId,
        },
        `[ExchangeConnector] ${wsArgs.symbol} createOrder ok orderId=${order.id} amount=${wsArgs.amount}`
      );

      return {
        ...resultBase,
        orderId: order.id,
        actualExchangeParams: { ...wsArgs },
        responseData: {
          id: order.id,
          orderId: order.id,
          symbol: order.symbol,
          rateLimit: order.rateLimit,
        },
      };
    } catch (error) {
      const errorMessage = formatErrorMessage({
        customMessage: 'Failed to create order',
        error,
      });
      const errorCode = error instanceof ExchangeError ? error.code : undefined;

      logger.error(
        { error, orderParams, exchange: this.exchangeName },
        errorMessage
      );

      return {
        ...resultBase,
        errorText: errorMessage,
        errorCode,
        actualExchangeParams: undefined,
      };
    }
  }

  public async createBatchOrders(orderParamsList: OrderParams[]): Promise<OrderResult[]> {
    if (orderParamsList.length === 0) {
      return [];
    }

    const firstParams = orderParamsList[0];
    const client = isSpot(firstParams.marketType) ? this.exchange.spot : this.exchange.futures;

    const wsArgsList = orderParamsList.map(params => this.buildCreateOrderArgs(params, client));
    const baseResultList: OrderResult[] = orderParamsList.map((orderParams, index) => ({
      exchangeName: this.exchangeName,
      orderParams,
      actualExchangeParams: { ...wsArgsList[index] },
    }));

    logger.info(
      {
        exchange: this.exchangeName,
        symbol: firstParams.symbol,
        marketType: firstParams.marketType,
        count: wsArgsList.length,
        orderList: wsArgsList.map(wsArgs => ({
          side: wsArgs.side,
          type: wsArgs.type,
          amount: wsArgs.amount,
          price: wsArgs.price,
          clientOrderId: wsArgs.clientOrderId,
        })),
      },
      `[ExchangeConnector] ${firstParams.symbol} createBatchOrders request count=${wsArgsList.length}`
    );

    try {
      const outcomeList = await client.createBatchOrders(wsArgsList);

      // Слой связи отдаёт по записи на каждую входную заявку, в исходном порядке, и сам
      // говорит, встала она или нет. Раньше исход приходилось угадывать по номеру заявки —
      // отсюда и сверка со словом «undefined»: так выглядел отказ Bybit, прикинувшийся успехом.
      return baseResultList.map((base, index) => {
        const outcome = outcomeList[index];

        if (outcome === undefined || !outcome.isSuccess || outcome.order === null) {
          return {
            ...base,
            errorText: outcome?.errorText ?? 'Order creation failed in batch',
          };
        }

        return {
          ...base,
          orderId: outcome.order.id,
          responseData: {
            id: outcome.order.id,
            orderId: outcome.order.id,
            symbol: outcome.order.symbol,
            rateLimit: outcome.rateLimit ?? outcome.order.rateLimit,
          },
        };
      });
    } catch (error) {
      const errorMessage = formatErrorMessage({
        customMessage: 'Failed to create batch orders',
        error,
      });
      const errorCode = error instanceof ExchangeError ? error.code : undefined;

      logger.error(
        { error, count: orderParamsList.length, exchange: this.exchangeName },
        errorMessage
      );

      return baseResultList.map(base => ({
        ...base,
        errorText: errorMessage,
        errorCode,
        actualExchangeParams: undefined,
      }));
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
    };

    const isMarketLike = orderParams.type === OrderTypeEnum.Market;

    if (!isMarketLike) {
      args.price = client.priceToPrecision(
        orderParams.symbol,
        orderParams.price
      );
    }

    const reduceOnly = readReduceOnly(orderParams);
    const isFuturesOrder = !isSpot(orderParams.marketType);

    if (isFuturesOrder) {
      if (orderParams.positionSide !== undefined) {
        args.positionSide = orderParams.positionSide;
      } else if (this.futuresPositionMode === PositionModeEnum.Hedge) {
        args.positionSide = inferHedgePositionSide(orderParams.side, reduceOnly);
        logger.warn(
          {
            exchangeName: this.exchangeName,
            symbol: orderParams.symbol,
            side: orderParams.side,
            reduceOnly,
            inferredPositionSide: args.positionSide,
          },
          `[${this.exchangeName.toUpperCase()}] positionSide auto-inferred from (side, reduceOnly) in Hedge mode — use PositionManager API for explicit control`
        );
      }

      if (reduceOnly) {
        args.reduceOnly = true;
      }

      if (orderParams.closePosition !== undefined) {
        args.closePosition = orderParams.closePosition;
      }

      if (orderParams.workingType !== undefined) {
        args.workingType = orderParams.workingType;
      }

      if (orderParams.triggerBy !== undefined) {
        args.triggerBy = orderParams.triggerBy;
      }

      if (orderParams.triggerDirection !== undefined) {
        args.triggerDirection = orderParams.triggerDirection;
      }

      if (orderParams.closeOnTrigger !== undefined) {
        args.closeOnTrigger = orderParams.closeOnTrigger;
      }
    } else {
      if (orderParams.orderFilter !== undefined) {
        args.orderFilter = orderParams.orderFilter;
      }

      if (orderParams.marketUnit !== undefined) {
        args.marketUnit = orderParams.marketUnit;
      }

      if (orderParams.quoteOrderQty !== undefined) {
        args.quoteOrderQty = orderParams.quoteOrderQty;
      }
    }

    // Скольжение стопа задаётся одинаково на любом рынке: отступ в процентах и цена, с
    // которой стоп начинает вести. Собственные единицы бирж прячет слой связи, поэтому
    // делить эти поля по рынкам здесь не нужно.
    if (orderParams.callbackRate !== undefined) {
      args.callbackRate = orderParams.callbackRate;
    }

    if (orderParams.activationPrice !== undefined) {
      args.activationPrice = client.priceToPrecision(
        orderParams.symbol,
        orderParams.activationPrice
      );
    }

    args.timeInForce = isMarketLike ? TimeInForceEnum.Ioc : TimeInForceEnum.Gtc;

    if (orderParams.triggerPrice !== undefined) {
      args.stopPrice = client.priceToPrecision(
        orderParams.symbol,
        orderParams.triggerPrice
      );
    }

    if (orderParams.clientOrderId !== undefined) {
      args.clientOrderId = orderParams.clientOrderId;
    }

    return args;
  }

  // Callers that want crypto perpetuals only pass { excludeTradifi: true }: tokenized TradFi
  // perpetuals (stocks, ETFs, commodities/metals) are dropped via TradeSymbol.isTradifi — the
  // exchange-specific markers (Binance contractType TRADIFI_PERPETUAL, Bybit symbolType
  // stock/commodity) are normalized into that flag by exchange-engine.
  public async getFuturesSymbols(options?: { excludeTradifi?: boolean }): Promise<string[]> {
    try {
      const tradeSymbolBySymbol = this.exchange.futures.tradeSymbols;
      const excludeTradifi = options?.excludeTradifi === true;

      const filteredSymbolList = [...tradeSymbolBySymbol.values()]
        .filter(m => m.isActive && (m.type === TradeSymbolTypeEnum.Swap || m.type === TradeSymbolTypeEnum.Future) && m.isLinear)
        .filter(m => !excludeTradifi || !m.isTradifi)
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

  /**
   * Ensure the futures trade-symbol spec (price/qty step, min/max filters) for `symbol`
   * is loaded before the caller sizes or places an order. Trade symbols load once at
   * initialize(); a symbol listed afterwards is absent until reloaded, and without its
   * spec amountToPrecision/priceToPrecision silently return un-stepped raw values the
   * exchange rejects. Returns true when the spec is present (already, or after an
   * on-demand reload), false when the symbol is still absent after a reload (genuinely
   * delisted / not yet listed).
   *
   * Fast path: a present spec returns immediately with NO REST call. A missing spec
   * triggers a single shared full reload (concurrent callers await the same promise); a
   * cooldown skips the reload for a symbol that does not exist so the instruments-info
   * endpoint is not hammered. The membership check uses `symbol` verbatim — the same key
   * priceToPrecision/getMinOrderQty resolve against — so the check matches actual use.
   */
  public async ensureFuturesTradeSymbolLoaded(symbol: string): Promise<boolean> {
    if (this.exchange.futures.tradeSymbols.has(symbol)) {
      return true;
    }

    await this.reloadFuturesTradeSymbolsOnDemand(symbol);

    return this.exchange.futures.tradeSymbols.has(symbol);
  }

  private async reloadFuturesTradeSymbolsOnDemand(symbol: string): Promise<void> {
    await this.reloadFuturesTradeSymbols(`${symbol} futures trade-symbol missing`);
  }

  /**
   * Refresh the futures trade-symbol cache from the exchange. getFuturesSymbols() reads a
   * cache that otherwise loads once at initialize(), so any periodic listing/delisting
   * sync (e.g. market-data-feeder's hourly symbol sync) must call this first — without it
   * the sync compares the cached list against itself and never sees a change. Shares the
   * single-flight reload and cooldown with the on-demand spec reload; a failed reload is
   * logged and swallowed so the caller keeps the previous cache (stale is better than
   * empty).
   */
  public async refreshFuturesTradeSymbols(): Promise<void> {
    await this.reloadFuturesTradeSymbols(`periodic futures trade-symbol refresh`);
  }

  private async reloadFuturesTradeSymbols(reasonLabel: string): Promise<void> {
    // Join an in-flight reload — concurrent callers share one REST round-trip.
    if (this.futuresTradeSymbolsReloadInFlight !== null) {
      await this.futuresTradeSymbolsReloadInFlight;

      return;
    }

    // Cooldown: a recent reload already refreshed the full list — skip another REST hit
    // until the cooldown elapses.
    const sinceLastReloadMs = Date.now() - this.lastFuturesTradeSymbolsReloadMs;

    if (this.lastFuturesTradeSymbolsReloadMs > 0 && sinceLastReloadMs < FUTURES_TRADE_SYMBOLS_RELOAD_COOLDOWN_MS) {
      logger.warn(
        { exchange: this.exchangeName, reasonLabel, sinceLastReloadMs },
        `[ExchangeConnector] ${reasonLabel} but reload on cooldown (${Math.round(sinceLastReloadMs / 1000)}s since last) — skipping reload`
      );

      return;
    }

    const reloadPromise = (async (): Promise<void> => {
      logger.info(
        { exchange: this.exchangeName, reasonLabel },
        `[ExchangeConnector] ${reasonLabel} — reloading all futures trade symbols`
      );
      await withReadRetry({
        fn: () => this.exchange.futures.loadTradeSymbols(),
        contextLabel: `reload futures trade symbols (${reasonLabel}) ${this.exchangeName}`,
      });
    })();

    this.futuresTradeSymbolsReloadInFlight = reloadPromise;

    try {
      await reloadPromise;
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName, reasonLabel },
        `[ExchangeConnector] futures trade-symbol reload failed (${reasonLabel})`
      );
    } finally {
      this.lastFuturesTradeSymbolsReloadMs = Date.now();
      this.futuresTradeSymbolsReloadInFlight = null;
    }
  }

  public async getSpotSymbols(): Promise<string[]> {
    try {
      const tradeSymbolBySymbol = this.exchange.spot.tradeSymbols;

      const filteredSymbolList = [...tradeSymbolBySymbol.values()]
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

  // Watchdog-proxied client for a market type (vs getClient → raw client). Stream
  // consumers that want subscription-health recovery (orderbook/publicTrade) must
  // subscribe through this so the watchdog wraps their handlers.
  public getStreamClient(marketType: MarketTypeEnum): ExchangeClient {
    return isSpot(marketType) ? this.spot : this.futures;
  }

  public getExchangeName(): ExchangeNameEnum {
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
    this.stopWatchingMarkPrices();

    this.stopStreamBundle(this.futuresStreamBundle);
    this.stopStreamBundle(this.spotStreamBundle);

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
