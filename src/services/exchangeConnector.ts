import * as crypto from 'crypto';

import { ExchangeError, Exchange as ExchangeInstance, ExchangeNameEnum, OrderSideEnum, PositionModeEnum, PositionSideEnum, TimeInForceEnum, TradeSymbolTypeEnum } from '@solncebro/exchange-engine';
import type { CreateOrderWebSocketArgs, ExchangeClient, ExchangeRateLimitState, FetchPageWithLimitArgs, Kline, KlineHandler, KlineInterval, LeverageTier, LeverageTierListBySymbol, MarkPriceHandler, MarkPriceUpdate, Order, OrderBook, OrderBookHandler, OrderRateLimit, PublicTradeHandler, StepRounding, SubscribeKlinesArgs, SubscribeOrderbookArgs, SubscribePublicTradesArgs, Ticker, TickerBySymbol } from '@solncebro/exchange-engine';

import { KlineSubscriptionWatchdog } from './klineSubscriptionWatchdog';
import type { KlineSubscriptionWatchdogConfig } from './klineSubscriptionWatchdog.types';
import { OrderBookTracker, resolveOrderBookStreamDepth } from './orderBookTracker';
import type { LiveOrderBook } from './orderBookTracker.types';
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
import { SubAccountGateway } from './subAccountGateway';
import { UserDataStreamRouter } from './userDataStreamRouter';

import { logger } from '../core/logger';
import { PositionManager } from '../core/positionManager';
import { RateLimitedRequestQueue } from '../core/RateLimitedRequestQueue';
import { withRetryOn429 } from '../core/withRetryOn429';
import {
  ExchangeConfig,
  ExchangeResponseData,
  MarketTypeEnum,
  OrderParams,
  OrderResult,
  OrderTypeEnum,
} from '../types';
import { describeError, describeExchangeRefusal, formatErrorMessage } from '../utils/errorFormatter.utils';
import { configureAmountStepSnapper } from '../utils/numberFormat';
import { isSpot } from '../utils/order.utils';
import { configurePriceTickSizeReader, configurePriceTickSnapper } from '../utils/priceFormat';
import { assertSymbolLoaded, sizeOrder, splitOrderQty } from '../utils/sizeOrder';
import type { AssertFuturesSymbolLoadedArgs, SizeFuturesOrderArgs, SizeOrderResult, SplitFuturesOrderQtyArgs } from '../utils/sizeOrder.types';
import { sleep } from '../utils/sleep';
import { normalizeSymbol, parseRawSymbolInput } from '../utils/symbol.utils';

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

// Schedule of the built-in instruments refresh. Omitted field = the 24h default; 0 (or a
// negative value) switches the schedule off entirely and leaves the caller to refresh by hand.
export interface TradeSymbolsRefreshConfig {
  tradeSymbolsRefreshIntervalMs?: number;
}

// The bulk ticker poll (every 30 s). Omitted field = the default: enabled, futures and spot. A consumer
// that needs only a few prices turns it off (or narrows the markets) and reads single symbols through
// refreshTicker instead of paying for the whole exchange list.
export interface TickerPollingConfig {
  isEnabled?: boolean;
  marketTypeList?: MarketTypeEnum[];
}

/** A symbol typed by a human / a signal, resolved against this exchange. */
export interface ResolvedSymbol {
  /** The exchange's name for it (with the 1000-style prefix when the exchange lists it so). */
  symbol: string;
  /** The exchange lists it and its trading spec is loaded — orders can be sized and placed. */
  isFound: boolean;
}

/**
 * The futures grid an app needs to compute a fee-adjusted breakeven that rounds AWAY from the
 * loss side and to split an amount into exchange-accepted lots — without reaching into the
 * exchange-engine client directly.
 */
export interface FuturesOrderRules {
  symbol: string;
  /** Price tick; 0 when the exchange gave none. */
  tickSize: number;
  /** Lot step of the amount (base coins/contracts); 0 when none. */
  stepSize: number;
  /** Smallest order amount (the client's getMinOrderQty). */
  minAmount: number;
  /** Smallest order value in quote currency (getMinNotional); 0 when the exchange has none. */
  minNotionalUsd: number;
  /** Largest amount of one limit order (the client's getMaxOrderQty). */
  maxAmount: number;
}

export interface SubscribeConnectorKlinesArgs extends SubscribeKlinesArgs {
  marketType: MarketTypeEnum;
}

export interface ReadKlinesArgs extends FetchPageWithLimitArgs {
  symbol: string;
  interval: KlineInterval;
  marketType: MarketTypeEnum;
}

// Per-market reload bookkeeping: one shared in-flight promise (concurrent callers join a
// single REST round-trip) plus the moment the last reload finished (cooldown).
interface TradeSymbolsReloadState {
  inFlight: Promise<void> | null;
  lastReloadMs: number;
}

interface StreamWatchdogBundle {
  kline: KlineSubscriptionWatchdog | null;
  orderbook: StreamSubscriptionWatchdog | null;
  publicTrade: StreamSubscriptionWatchdog | null;
  markPrice: StreamSubscriptionWatchdog | null;
}

const FALLBACK_WRITE_REQUESTS_PER_SECOND = 10;

// Min gap between full trade-symbol reloads of one market (triggered by a missing
// symbol). Trade symbols load once at initialize(); a symbol listed afterwards is absent
// until reloaded. This cooldown guards the instruments-info REST endpoint from being
// hammered when a chaser is created for a symbol that genuinely does not exist.
const TRADE_SYMBOLS_RELOAD_COOLDOWN_MS = 60_000;

// Built-in daily instruments refresh. Trade symbols load once at initialize(), so a process
// that lives for weeks never learns about a coin listed after its start. The round is pinned
// to 00:05 UTC — right past the daily candle boundary and the daily reports apps send, the
// quietest minute of the day — and carries a random 0..120s shift so several processes on one
// IP do not knock on the exchange in the very same instant. One instruments-info read per
// market per day weighs nothing against any rate limit.
const TRADE_SYMBOLS_REFRESH_DAY_MS = 24 * 60 * 60 * 1000;
const TRADE_SYMBOLS_REFRESH_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRADE_SYMBOLS_REFRESH_UTC_HOUR = 0;
const TRADE_SYMBOLS_REFRESH_UTC_MINUTE = 5;
const TRADE_SYMBOLS_REFRESH_JITTER_MAX_MS = 120_000;
const DAILY_TRADE_SYMBOLS_REFRESH_REASON = 'daily trade-symbol refresh';
const MANUAL_TRADE_SYMBOLS_REFRESH_REASON = 'trade-symbol refresh';

// Leverage tiers (Bybit risk limits, Binance leverage brackets, OKX position tiers) sit next to the
// instrument specs: loaded once at initialize(), re-read by the same daily round, and fetched for one
// symbol on demand when an app meets a symbol the bulk read did not know (a fresh listing). Per-symbol
// misses are cooled down so a symbol the exchange has no tiers for does not get asked on every order.
const LEVERAGE_TIER_SYMBOL_RELOAD_COOLDOWN_MS = 60_000;
const INITIAL_LEVERAGE_TIER_LOAD_REASON = 'initial leverage-tier load';
// Exchanges whose tier read is a SIGNED request: Binance /fapi/v1/leverageBracket (exchange-engine
// BinanceFuturesHttpClient signedGet). Bybit /v5/market/risk-limit and OKX /api/v5/public/position-tiers
// are market data and answer without a key. A keyless connector (public market data only) skips the
// signed read instead of sending an empty key and logging the exchange's 401.
const SIGNED_LEVERAGE_TIER_EXCHANGE_NAME_SET: ReadonlySet<ExchangeNameEnum> = new Set([ExchangeNameEnum.Binance]);

// initialize() starts the ticker cache without waiting for it (a slow first read must not hold the
// start), so a symbol resolved right after start could miss its 1000-style prefix. Resolution waits
// for the first snapshot this long; readiness is re-checked at the poll step while waiting.
const TICKERS_READY_DEFAULT_TIMEOUT_MS = 30_000;
const TICKERS_READY_POLL_MS = 500;
const RESOLVE_SYMBOL_TICKERS_WAIT_MS = 15_000;
const MULTIPLIER_SUFFIX_QUOTE_LIST = ['USDT', 'USDC'];
// A symbol refreshed (single read or bulk poll) this recently is served from the cache.
const TICKER_REFRESH_MIN_INTERVAL_MS = 5000;
// Exchanges whose create-order result carries the exchange's own acceptance time in updatedTimestamp
// (Binance new-order response `updateTime`). exchange-engine stamps its local clock into the Bybit
// create-order result, so passing that through would present the bot's clock as the exchange's.
const ORDER_ACCEPTANCE_TIME_EXCHANGE_NAME_SET: ReadonlySet<ExchangeNameEnum> = new Set([ExchangeNameEnum.Binance]);

function readExchangeAcceptedAtMs(exchangeName: ExchangeNameEnum, order: Pick<Order, 'updatedTimestamp'>): number | undefined {
  if (!ORDER_ACCEPTANCE_TIME_EXCHANGE_NAME_SET.has(exchangeName)) {
    return undefined;
  }

  const acceptedAtMs = order.updatedTimestamp;

  return Number.isFinite(acceptedAtMs) && acceptedAtMs > 0 ? acceptedAtMs : undefined;
}

// Only what the exchange itself answered to the placement: the exchange layer marks it, and an
// answer with the number alone (Bybit, OKX) leaves both keys out — the request is never echoed here.
function readAcceptedPlacement(order: Pick<Order, 'acceptedAmount' | 'acceptedStatus'>): Partial<Pick<ExchangeResponseData, 'amount' | 'status'>> {
  return {
    ...(order.acceptedAmount === undefined ? {} : { amount: order.acceptedAmount }),
    ...(order.acceptedStatus === undefined ? {} : { status: order.acceptedStatus }),
  };
}

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
  private _subAccountGateway: SubAccountGateway | null = null;
  private currentFuturesPositionMode: PositionModeEnum;

  private readonly futuresStreamBundle: StreamWatchdogBundle;
  private readonly spotStreamBundle: StreamWatchdogBundle;
  private _futuresProxy: ExchangeClient | null = null;
  private _spotProxy: ExchangeClient | null = null;
  private readonly rateLimitConfigOverride: RateLimitConfig | null | undefined;
  private writeQueue: RateLimitedRequestQueue | null = null;
  private readonly exchangeLabel: string;
  private readonly orderBookTrackerByMarketType: Map<MarketTypeEnum, OrderBookTracker> = new Map();

  // Trade-symbol reload state per market (single-flight + cooldown), see TradeSymbolsReloadState.
  private readonly tradeSymbolsReloadStateByMarketType: Map<MarketTypeEnum, TradeSymbolsReloadState> = new Map();

  // Daily instruments refresh: the interval taken from config, the pending timer, the flag that
  // says the schedule is alive (a round in progress must not re-arm after disconnect) and the
  // guard that keeps two rounds from overlapping.
  private readonly tradeSymbolsRefreshIntervalMs: number;
  private tradeSymbolsRefreshTimeoutId: NodeJS.Timeout | null = null;
  private isTradeSymbolsRefreshScheduled: boolean = false;
  private isRefreshingAllTradeSymbols: boolean = false;

  // Futures leverage tiers by symbol; the bulk read replaces the whole map, a per-symbol read one entry.
  private readonly futuresLeverageTierListBySymbol: LeverageTierListBySymbol = new Map();
  private leverageTierBulkLoadInFlight: Promise<void> | null = null;
  private readonly leverageTierSymbolLoadInFlightBySymbol: Map<string, Promise<void>> = new Map();
  private readonly leverageTierMissAtMsBySymbol: Map<string, number> = new Map();
  private readonly isKeyless: boolean;
  private isKeylessTierSkipLogged: boolean = false;
  private firstTickerRoundPromise: Promise<void> | null = null;
  private readonly tickerSnapshotMarketTypeSet: Set<MarketTypeEnum> = new Set();
  private readonly isTickerPollingEnabled: boolean;
  private readonly tickerPollingMarketTypeList: MarketTypeEnum[];
  private readonly tickerRefreshedAtMsByKey: Map<string, number> = new Map();
  private readonly tickerRefreshInFlightByKey: Map<string, Promise<Ticker | null>> = new Map();
  // Opt-in market-data sharing between connectors of one exchange (master + sub-accounts): the follower
  // reads the primary's tickers and leverage tiers and copies its trade-symbol specs instead of loading
  // all of it again per account. See shareMarketDataFrom.
  private readonly isDemoMode: boolean;
  private marketDataPrimary: ExchangeConnector | null = null;
  private readonly marketDataFollowerList: ExchangeConnector[] = [];
  private hasInitializeStarted: boolean = false;
  private readonly userDataStreamRouterByMarketType: Map<MarketTypeEnum, UserDataStreamRouter> = new Map();

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
    streamWatchdogConfig?: StreamWatchdogConfigMap,
    tradeSymbolsRefreshConfig?: TradeSymbolsRefreshConfig,
    tickerPollingConfig?: TickerPollingConfig
  ) {
    this.exchangeName = exchangeName;
    this.isTickerPollingEnabled = tickerPollingConfig?.isEnabled !== false;
    this.tickerPollingMarketTypeList = tickerPollingConfig?.marketTypeList ?? [MarketTypeEnum.Futures, MarketTypeEnum.Spot];
    this.isDemoMode = config.isDemoMode === true;
    this.isKeyless = (config.apiKey ?? '').trim() === '' || (config.secret ?? '').trim() === '';
    this.currentFuturesPositionMode = futuresPositionMode;
    this.rateLimitConfigOverride = rateLimitConfig;
    this.tradeSymbolsRefreshIntervalMs =
      tradeSymbolsRefreshConfig?.tradeSymbolsRefreshIntervalMs ?? TRADE_SYMBOLS_REFRESH_DEFAULT_INTERVAL_MS;

    this.exchange = new ExchangeInstance(exchangeName, {
      config,
      logger,
      onNotify,
    });

    const exchangeLabel = exchangeName.charAt(0).toUpperCase() + exchangeName.slice(1);

    this.exchangeLabel = exchangeLabel;

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

  /** The futures position mode orders are built for (one-way — no position side; hedge — LONG / SHORT). */
  public get futuresPositionMode(): PositionModeEnum {
    return this.currentFuturesPositionMode;
  }

  /**
   * Local only: orders built from now on follow this mode. Call it after the exchange confirmed the mode
   * (PositionManager.setPositionMode does both) or after reading the account's actual mode at start.
   */
  public adoptFuturesPositionMode(mode: PositionModeEnum): void {
    this.currentFuturesPositionMode = mode;
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

  /**
   * Sub-account operations of this (master) account: list, transfers both ways with the caller's
   * idempotency id, transfer status, sub-account balances. Results, never throws; demo mode and OKX
   * answer `isNotSupported`. Lazy, one per connector.
   */
  public get subAccounts(): SubAccountGateway {
    if (this._subAccountGateway === null) {
      this._subAccountGateway = new SubAccountGateway({
        client: this.exchange.subAccount,
        label: `${this.exchangeLabel}${this.isDemoMode ? ' demo' : ''}`,
      });
    }

    return this._subAccountGateway;
  }

  public getWriteQueue(): RateLimitedRequestQueue | null {
    if (this.rateLimitConfigOverride === null) {
      return null;
    }

    return this.getOrCreateWriteQueue();
  }

  public async initialize(): Promise<void> {
    this.hasInitializeStarted = true;

    if (this.marketDataPrimary !== null) {
      await this.initializeAsMarketDataFollower(this.marketDataPrimary);

      return;
    }

    try {
      await withRetryOn429({
        fn: () => this.exchange.futures.loadTradeSymbols(),
        contextLabel: `loadTradeSymbols futures ${this.exchangeName}`,
      });
      await withRetryOn429({
        fn: () => this.exchange.spot.loadTradeSymbols(),
        contextLabel: `loadTradeSymbols spot ${this.exchangeName}`,
      });
      await this.resolveWriteQueueOnInitialize();
      this.installPriceTickSnapper();
      this.installAmountStepSnapper();
      this.startWatchingTickers();
      this.startDailyTradeSymbolsRefresh();
      await this.loadFuturesLeverageTiers(INITIAL_LEVERAGE_TIER_LOAD_REASON);
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName },
        'Failed to initialize exchange'
      );

      throw error;
    }
  }

  /**
   * Opt-in: take market data (trade-symbol specs, tickers, leverage tiers) from `primary` — a connector
   * of the SAME exchange and the same demo/live mode, usually the master account — instead of loading
   * it again. That data is public and identical for every account of an exchange; five connectors
   * (master + four sub-accounts) otherwise read the instruments list, the tickers every 30 s and the
   * tier table five times over. Account-bound things stay per connector: orders, positions, balances,
   * leverage/margin settings, the write rate-limit queue, user-data and order-book streams.
   *
   * Call before initialize(); initialize the primary first. The follower then does no market-data
   * reads of its own: tickers and tiers are read from the primary live, the trade-symbol specs are
   * copied into the follower's own client (its price/amount rounding reads them there) and re-copied
   * after every reload the primary makes (daily round, on-demand reload of a fresh listing).
   */
  public shareMarketDataFrom(primary: ExchangeConnector): void {
    if (primary === this) {
      throw new Error('[ExchangeConnector] a connector cannot share market data with itself');
    }

    if (primary.exchangeName !== this.exchangeName || primary.isDemoMode !== this.isDemoMode) {
      throw new Error(
        `[ExchangeConnector] market data can only be shared within one exchange and one mode (primary ${primary.exchangeName}${primary.isDemoMode ? ' demo' : ''}, follower ${this.exchangeName}${this.isDemoMode ? ' demo' : ''})`
      );
    }

    if (primary.marketDataPrimary !== null) {
      throw new Error('[ExchangeConnector] the primary itself follows another connector — share from the root primary');
    }

    if (this.hasInitializeStarted || this.marketDataFollowerList.length > 0 || this.marketDataPrimary !== null) {
      throw new Error('[ExchangeConnector] shareMarketDataFrom must be called once, before initialize(), on a connector nobody follows');
    }

    this.marketDataPrimary = primary;
    this.tickersByMarketTypeAndSymbol = primary.tickersByMarketTypeAndSymbol;
    primary.marketDataFollowerList.push(this);
  }

  /** True when this connector reads its market data from another one (shareMarketDataFrom). */
  public isMarketDataFollower(): boolean {
    return this.marketDataPrimary !== null;
  }

  private async initializeAsMarketDataFollower(primary: ExchangeConnector): Promise<void> {
    if (primary.exchange.futures.tradeSymbols.size === 0) {
      throw new Error('[ExchangeConnector] the market-data primary has no trade symbols loaded — initialize the primary first');
    }

    this.copyTradeSymbolsFromPrimary(MarketTypeEnum.Futures);
    this.copyTradeSymbolsFromPrimary(MarketTypeEnum.Spot);
    await this.resolveWriteQueueOnInitialize();
    logger.info(
      { exchange: this.exchangeName, futuresSymbolCount: this.exchange.futures.tradeSymbols.size },
      `[ExchangeConnector] ${this.exchangeName} initialized with market data shared from the primary connector`
    );
  }

  private copyTradeSymbolsFromPrimary(marketType: MarketTypeEnum): void {
    if (this.marketDataPrimary === null) {
      return;
    }

    const sourceBySymbol = this.marketDataPrimary.getClient(marketType).tradeSymbols;
    const targetBySymbol = this.getClient(marketType).tradeSymbols;

    targetBySymbol.clear();

    for (const [symbol, tradeSymbol] of sourceBySymbol) {
      targetBySymbol.set(symbol, tradeSymbol);
    }
  }

  private syncFollowerTradeSymbols(marketType: MarketTypeEnum): void {
    for (const follower of this.marketDataFollowerList) {
      follower.copyTradeSymbolsFromPrimary(marketType);
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
    configurePriceTickSnapper((symbol, price, rounding) =>
      this.exchange.futures.tradeSymbols.has(symbol)
        ? this.exchange.futures.priceToPrecision(symbol, price, rounding)
        : this.exchange.spot.tradeSymbols.has(symbol)
          ? this.exchange.spot.priceToPrecision(symbol, price, rounding)
          : price
    );
    // Same lookup order as the snapper above, so the reported tick is the one the snapper rounds to.
    configurePriceTickSizeReader((symbol) => {
      const tradeSymbol = this.exchange.futures.tradeSymbols.get(symbol) ?? this.exchange.spot.tradeSymbols.get(symbol);

      return tradeSymbol === undefined ? null : parseFloat(tradeSymbol.filter.tickSize);
    });
  }

  /**
   * Same wiring for contracts amounts: the lot step of every loaded symbol becomes the grid that
   * `formatAmount` / `snapAmountToStep` use, so a computed quantity prints as the exchange holds it.
   */
  private installAmountStepSnapper(): void {
    configureAmountStepSnapper((symbol, amount, rounding) =>
      this.exchange.futures.tradeSymbols.has(symbol)
        ? this.exchange.futures.amountToPrecision(symbol, amount, rounding)
        : this.exchange.spot.tradeSymbols.has(symbol)
          ? this.exchange.spot.amountToPrecision(symbol, amount, rounding)
          : amount
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
    if (this.isWatchingTickers || !this.isTickerPollingEnabled) {
      return;
    }

    this.isWatchingTickers = true;

    const firstRound = this.updateTickers();

    this.firstTickerRoundPromise = firstRound;
    await firstRound;

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
      const tickerBySymbolList = await Promise.all(
        this.tickerPollingMarketTypeList.map(marketType =>
          withRetryOn429({
            fn: () => this.getClient(marketType).fetchTickers(),
            contextLabel: `fetchTickers ${marketType} ${this.exchangeName}`,
          })
        )
      );

      this.tickerPollingMarketTypeList.forEach((marketType, index) => {
        this.processTickerList(tickerBySymbolList[index], marketType);
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to update tickers');
    }
  }

  /**
   * Reads ONE symbol's ticker now and stores it in the same cache (same key) the bulk poll fills, so
   * getTicker sees it. For a consumer that runs with the bulk poll off or narrowed. A symbol refreshed
   * under 5 s ago is served from the cache, concurrent calls for one symbol share one request, a
   * follower hands the call to its primary. Never throws: a failed read warns and returns whatever
   * the cache holds (possibly null). `shouldServeCacheOnFailure: false` returns null on a failed read
   * instead: the cache may be a bulk-poll price up to 30 s old, which a caller asking for a fresh price
   * must not take for one (the ticker's timestamp cannot tell — Binance puts the 24h window's close time
   * there, Bybit the time of the answer).
   */
  public async refreshTicker(
    symbol: string,
    marketType: MarketTypeEnum,
    options?: { shouldServeCacheOnFailure?: boolean }
  ): Promise<Ticker | null> {
    if (this.marketDataPrimary !== null) {
      return this.marketDataPrimary.refreshTicker(symbol, marketType, options);
    }

    const tickerKey = this.getTickerKey(normalizeSymbol(symbol), marketType);
    const cachedTicker = this.tickersByMarketTypeAndSymbol.get(tickerKey) ?? null;
    const refreshedAtMs = this.tickerRefreshedAtMsByKey.get(tickerKey);

    if (cachedTicker !== null && refreshedAtMs !== undefined && Date.now() - refreshedAtMs < TICKER_REFRESH_MIN_INTERVAL_MS) {
      return cachedTicker;
    }

    const freshTicker = await this.fetchSingleTickerShared(symbol, marketType, tickerKey);

    if (freshTicker !== null || options?.shouldServeCacheOnFailure === false) {
      return freshTicker;
    }

    return this.tickersByMarketTypeAndSymbol.get(tickerKey) ?? null;
  }

  // Concurrent callers share one request whatever they do on its failure, so the shared result is the
  // read alone: null = the read failed, and each caller decides about the cache itself.
  private fetchSingleTickerShared(symbol: string, marketType: MarketTypeEnum, tickerKey: string): Promise<Ticker | null> {
    const inFlight = this.tickerRefreshInFlightByKey.get(tickerKey);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const request = this.fetchSingleTicker(symbol, marketType, tickerKey).finally(() => {
      this.tickerRefreshInFlightByKey.delete(tickerKey);
    });

    this.tickerRefreshInFlightByKey.set(tickerKey, request);

    return request;
  }

  private async fetchSingleTicker(symbol: string, marketType: MarketTypeEnum, tickerKey: string): Promise<Ticker | null> {
    try {
      const ticker = await withRetryOn429({
        fn: () => this.getClient(marketType).fetchTicker(symbol),
        contextLabel: `fetchTicker ${marketType} ${symbol} ${this.exchangeName}`,
      });

      this.tickersByMarketTypeAndSymbol.set(tickerKey, ticker);
      this.tickerRefreshedAtMsByKey.set(tickerKey, Date.now());

      return ticker;
    } catch (error) {
      logger.warn(
        { exchange: this.exchangeName, marketType, symbol, errorText: describeError(error) },
        '[ExchangeConnector] single ticker read failed'
      );

      return null;
    }
  }

  private processTickerList(
    tickerBySymbol: TickerBySymbol,
    marketType: MarketTypeEnum
  ): void {
    const refreshedAtMs = Date.now();

    for (const [symbol, ticker] of tickerBySymbol) {
      const normalizedSymbol = normalizeSymbol(symbol);
      const tickerKey = this.getTickerKey(normalizedSymbol, marketType);
      this.tickersByMarketTypeAndSymbol.set(tickerKey, ticker);
      this.tickerRefreshedAtMsByKey.set(tickerKey, refreshedAtMs);
    }

    if (tickerBySymbol.size > 0) {
      this.tickerSnapshotMarketTypeSet.add(marketType);
    }
  }

  /**
   * Resolves once the ticker cache holds a snapshot of `marketType` (default futures), or after
   * `timeoutMs`. initialize() starts the cache without awaiting it, so the prefix search
   * (resolveSymbolWithPrefix) right after start could look into an empty cache and miss 1000PEPEUSDT.
   * Never throws: false means the snapshot did not arrive in time (the read failed and the next round
   * is 30 s away, or initialize() was not called) — the caller decides whether to go on without it.
   */
  public async waitForTickersReady(
    timeoutMs: number = TICKERS_READY_DEFAULT_TIMEOUT_MS,
    marketType: MarketTypeEnum = MarketTypeEnum.Futures
  ): Promise<boolean> {
    if (this.marketDataPrimary !== null) {
      return this.marketDataPrimary.waitForTickersReady(timeoutMs, marketType);
    }

    // No bulk snapshot of this market will ever come: do not make the caller sit out the timeout.
    if (!this.isTickerPollingEnabled || !this.tickerPollingMarketTypeList.includes(marketType)) {
      return this.tickerSnapshotMarketTypeSet.has(marketType);
    }

    const deadlineMs = Date.now() + timeoutMs;

    while (!this.tickerSnapshotMarketTypeSet.has(marketType)) {
      const remainingMs = deadlineMs - Date.now();

      if (remainingMs <= 0) {
        return false;
      }

      const waitMs = Math.min(TICKERS_READY_POLL_MS, remainingMs);

      if (this.firstTickerRoundPromise !== null) {
        await Promise.race([this.firstTickerRoundPromise, sleep(waitMs)]);
      } else {
        await sleep(waitMs);
      }

      if (this.firstTickerRoundPromise !== null && !this.tickerSnapshotMarketTypeSet.has(marketType)) {
        // The first round settled without this market: stop racing a finished promise, poll plainly.
        this.firstTickerRoundPromise = null;
      }
    }

    return true;
  }

  private getTickerKey(symbol: string, marketType: MarketTypeEnum): string {
    return `${marketType}:${symbol}`;
  }

  private readonly symbolPrefixList = [10, 100, 1000, 10000, 100000, 1000000];

  public resolveSymbolWithPrefix(
    symbol: string,
    marketType: MarketTypeEnum
  ): string {
    const foundSymbol = this.findSymbolWithPrefix(symbol, marketType);

    if (foundSymbol !== null) {
      return foundSymbol;
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

  /**
   * Same search as resolveSymbolWithPrefix — the name as is, then the 10…1000000 prefixes, against the
   * ticker cache — but a miss is reported as null instead of the input handed back, so the caller can
   * tell "found as is" from "not listed at all".
   */
  public findSymbolWithPrefix(symbol: string, marketType: MarketTypeEnum): string | null {
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

    return null;
  }

  /**
   * Bybit writes some multipliers AFTER the base: SHIB1000USDT, not 1000SHIBUSDT (its public linear
   * tickers, read 25.09.2026). resolveSymbolWithPrefix never looked there and keeps not looking — this
   * is used by resolveFuturesSymbol / resolveSpotSymbol only.
   */
  private findSymbolWithMultiplierSuffix(symbol: string, marketType: MarketTypeEnum): string | null {
    const quote = MULTIPLIER_SUFFIX_QUOTE_LIST.find(item => symbol.length > item.length && symbol.endsWith(item));

    if (quote === undefined) {
      return null;
    }

    const base = symbol.slice(0, -quote.length);

    for (const prefix of this.symbolPrefixList) {
      const suffixedSymbol = `${base}${prefix}${quote}`;

      if (this.tickersByMarketTypeAndSymbol.has(this.getTickerKey(suffixedSymbol, marketType))) {
        return suffixedSymbol;
      }
    }

    return null;
  }

  /**
   * The same candidates in the same order (as is, the 10…1000000 prefix, the multiplier after the base)
   * against the instruments list (`tradeSymbols`) instead of the ticker cache. The cache stays empty
   * when the all-coin poll is off, the list is loaded at start and refreshed daily either way. Reached
   * only after the cache found nothing, so a coin the cache knows resolves exactly as before.
   */
  private findSymbolInTradeSymbols(symbol: string, marketType: MarketTypeEnum): string | null {
    const tradeSymbolBySymbol = this.getClient(marketType).tradeSymbols;
    const quote = MULTIPLIER_SUFFIX_QUOTE_LIST.find(item => symbol.length > item.length && symbol.endsWith(item));
    const base = quote === undefined ? null : symbol.slice(0, -quote.length);
    const candidateList = [
      symbol,
      ...this.symbolPrefixList.map(prefix => `${prefix}${symbol}`),
      ...(quote === undefined || base === null ? [] : this.symbolPrefixList.map(prefix => `${base}${prefix}${quote}`)),
    ];

    return candidateList.find(candidate => tradeSymbolBySymbol.has(candidate)) ?? null;
  }

  /**
   * Human / signal input → this exchange's futures symbol: "$pepe", "#BTC", "BTC/USDT", "BTCUSDT.P"
   * (parseRawSymbolInput), then the 1000-style prefix by the ticker cache (waits for its first
   * snapshot), then the same candidates by the instruments list (the cache is empty with the poll off),
   * then the trading spec (a coin listed after start is fetched on demand). `isFound`
   * false: not listed on this exchange (or the input had no symbol in it); `symbol` is then the best
   * guess, for the message to the human.
   */
  public async resolveFuturesSymbol(raw: string): Promise<ResolvedSymbol> {
    return this.resolveMarketSymbol(raw, MarketTypeEnum.Futures);
  }

  /** Spot twin of resolveFuturesSymbol. */
  public async resolveSpotSymbol(raw: string): Promise<ResolvedSymbol> {
    return this.resolveMarketSymbol(raw, MarketTypeEnum.Spot);
  }

  private async resolveMarketSymbol(raw: string, marketType: MarketTypeEnum): Promise<ResolvedSymbol> {
    const parsedSymbol = parseRawSymbolInput(raw);

    if (parsedSymbol === null) {
      return { symbol: raw.trim().toUpperCase(), isFound: false };
    }

    await this.waitForTickersReady(RESOLVE_SYMBOL_TICKERS_WAIT_MS, marketType);

    const symbol = this.findSymbolWithPrefix(parsedSymbol, marketType)
      ?? this.findSymbolWithMultiplierSuffix(parsedSymbol, marketType)
      ?? this.findSymbolInTradeSymbols(parsedSymbol, marketType)
      ?? parsedSymbol;
    const isFound = isSpot(marketType)
      ? await this.ensureSpotTradeSymbolLoaded(symbol)
      : await this.ensureFuturesTradeSymbolLoaded(symbol);

    return { symbol, isFound };
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

  /**
   * The one private (user-data) stream of this account's market, shared by every consumer — subscribe
   * OrderManager, PositionMonitor and the app's handlers to it, then connect() once. Never per market
   * data follower: orders and fills are per account.
   */
  public getUserDataStreamRouter(marketType: MarketTypeEnum = MarketTypeEnum.Futures): UserDataStreamRouter {
    const existing = this.userDataStreamRouterByMarketType.get(marketType);

    if (existing !== undefined) {
      return existing;
    }

    const router = new UserDataStreamRouter({
      client: this.getClient(marketType),
      label: `${this.exchangeLabel} ${isSpot(marketType) ? 'Spot' : 'Futures'}`,
    });

    this.userDataStreamRouterByMarketType.set(marketType, router);

    return router;
  }

  public isUserDataStreamConnected(marketType: MarketTypeEnum = MarketTypeEnum.Futures): boolean {
    return this.getClient(marketType).isUserDataStreamConnected();
  }

  /** The exchange's weight usage and ban by the last answer — no network call; null fields — unknown. */
  public getRateLimitState(marketType: MarketTypeEnum = MarketTypeEnum.Futures): ExchangeRateLimitState {
    return this.getClient(marketType).getRateLimitState();
  }

  // ---- Order book: the single door to depth for consumers (never the raw client) ----

  private getOrCreateOrderBookTracker(marketType: MarketTypeEnum): OrderBookTracker {
    const existing = this.orderBookTrackerByMarketType.get(marketType);

    if (existing !== undefined) {
      return existing;
    }

    // Subscribe through the proxied client so the orderbook watchdog (when enabled) wraps
    // the tracker's handler and recovers a silent topic; a passthrough when disabled.
    const tracker = new OrderBookTracker({
      client: this.getStreamClient(marketType),
      depth: resolveOrderBookStreamDepth(this.exchangeName),
      clientLabel: `${this.exchangeLabel} ${isSpot(marketType) ? 'Spot' : 'Futures'}`,
    });

    this.orderBookTrackerByMarketType.set(marketType, tracker);

    return tracker;
  }

  /**
   * Starts keeping a live order book for `symbol` (reference-counted; see OrderBookTracker).
   * Throws when the market has no order book stream (e.g. Binance spot).
   */
  public subscribeOrderBook(symbol: string, marketType: MarketTypeEnum): void {
    this.getOrCreateOrderBookTracker(marketType).subscribe(symbol);
  }

  public unsubscribeOrderBook(symbol: string, marketType: MarketTypeEnum): void {
    this.orderBookTrackerByMarketType.get(marketType)?.unsubscribe(symbol);
  }

  // Goes through the watchdog-proxied client (getStreamClient) so the kline watchdog sees the subscription.
  public subscribeKlines(args: SubscribeConnectorKlinesArgs): void {
    this.getStreamClient(args.marketType).subscribeKlines({ symbol: args.symbol, interval: args.interval, handler: args.handler });
  }

  public unsubscribeKlines(args: SubscribeConnectorKlinesArgs): void {
    this.getStreamClient(args.marketType).unsubscribeKlines({ symbol: args.symbol, interval: args.interval, handler: args.handler });
  }

  /** The live merged book, or null while no snapshot is held (not subscribed / not arrived yet / sequence broke). */
  public getOrderBook(symbol: string, marketType: MarketTypeEnum): LiveOrderBook | null {
    return this.orderBookTrackerByMarketType.get(marketType)?.getBook(symbol) ?? null;
  }

  /** One REST read of the book — the fallback when the live book is not available in time. */
  public async fetchOrderBook(symbol: string, marketType: MarketTypeEnum, limit?: number): Promise<OrderBook> {
    return withRetryOn429({
      fn: () => this.getClient(marketType).fetchOrderBook(symbol, limit),
      contextLabel: `fetchOrderBook ${symbol}`,
    });
  }

  public async readKlines(args: ReadKlinesArgs): Promise<Kline[]> {
    const { symbol, interval, marketType, ...options } = args;

    return withRetryOn429({
      fn: () => this.getClient(marketType).fetchKlines(symbol, interval, options),
      contextLabel: `readKlines ${symbol} ${interval}`,
    });
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
          timestamp: readExchangeAcceptedAtMs(this.exchangeName, order),
          rateLimit: order.rateLimit,
          ...readAcceptedPlacement(order),
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
        errorText: describeExchangeRefusal(error),
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
            timestamp: readExchangeAcceptedAtMs(this.exchangeName, outcome.order),
            rateLimit: outcome.rateLimit ?? outcome.order.rateLimit,
            ...readAcceptedPlacement(outcome.order),
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
        errorText: describeExchangeRefusal(error),
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

    args.timeInForce = isMarketLike ? TimeInForceEnum.Ioc : (orderParams.timeInForce ?? TimeInForceEnum.Gtc);

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

  /**
   * The futures price/amount grid and order-size floors for `symbol`, read from the same
   * `tradeSymbols` cache `installPriceTickSnapper`/`installAmountStepSnapper` already key off.
   * `null` when the spec is not loaded — the caller loads it first with
   * `ensureFuturesTradeSymbolLoaded`, same as every other symbol-spec reader here.
   */
  public getFuturesOrderRules(symbol: string): FuturesOrderRules | null {
    const tradeSymbol = this.exchange.futures.tradeSymbols.get(symbol);

    if (tradeSymbol === undefined) {
      return null;
    }

    const tickSize = parseFloat(tradeSymbol.filter.tickSize);
    const stepSize = parseFloat(tradeSymbol.filter.stepSize);

    return {
      symbol,
      tickSize: Number.isFinite(tickSize) ? tickSize : 0,
      stepSize: Number.isFinite(stepSize) ? stepSize : 0,
      minAmount: this.exchange.futures.getMinOrderQty(symbol),
      minNotionalUsd: this.exchange.futures.getMinNotional(symbol),
      maxAmount: this.exchange.futures.getMaxOrderQty(symbol),
    };
  }

  public amountToFuturesPrecision(symbol: string, amount: number, rounding?: StepRounding): number {
    return this.exchange.futures.amountToPrecision(symbol, amount, rounding);
  }

  // The sizing utilities take the exchange client; these delegates hand them this connector's own
  // futures client so an app sizes orders without holding the raw client.
  public sizeFuturesOrder(args: SizeFuturesOrderArgs): SizeOrderResult {
    return sizeOrder({ ...args, exchangeClient: this.exchange.futures });
  }

  public splitFuturesOrderQty(args: SplitFuturesOrderQtyArgs): number[] {
    return splitOrderQty({ ...args, exchangeClient: this.exchange.futures });
  }

  public assertFuturesSymbolLoaded(args: AssertFuturesSymbolLoadedArgs): string | undefined {
    return assertSymbolLoaded({ ...args, exchangeClient: this.exchange.futures });
  }

  /** Spot twin of ensureFuturesTradeSymbolLoaded: same single-flight reload and cooldown. */
  public async ensureSpotTradeSymbolLoaded(symbol: string): Promise<boolean> {
    if (this.exchange.spot.tradeSymbols.has(symbol)) {
      return true;
    }

    await this.reloadSpotTradeSymbols(`${symbol} spot trade-symbol missing`);

    return this.exchange.spot.tradeSymbols.has(symbol);
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
    await this.reloadTradeSymbolsForMarket(MarketTypeEnum.Futures, reasonLabel);
  }

  /**
   * Spot twin of the futures reload: same single-flight promise, same cooldown, same swallowed
   * failure. Spot had no reload at all — its instruments cache lived exactly as long as the
   * process, so a pair listed on spot after start stayed invisible forever.
   */
  private async reloadSpotTradeSymbols(reasonLabel: string): Promise<void> {
    await this.reloadTradeSymbolsForMarket(MarketTypeEnum.Spot, reasonLabel);
  }

  private getTradeSymbolsReloadState(marketType: MarketTypeEnum): TradeSymbolsReloadState {
    const knownState = this.tradeSymbolsReloadStateByMarketType.get(marketType);

    if (knownState !== undefined) {
      return knownState;
    }

    const state: TradeSymbolsReloadState = { inFlight: null, lastReloadMs: 0 };
    this.tradeSymbolsReloadStateByMarketType.set(marketType, state);

    return state;
  }

  private async reloadTradeSymbolsForMarket(marketType: MarketTypeEnum, reasonLabel: string): Promise<void> {
    if (this.marketDataPrimary !== null) {
      await this.marketDataPrimary.reloadTradeSymbolsForMarket(marketType, reasonLabel);
      this.copyTradeSymbolsFromPrimary(marketType);

      return;
    }

    const state = this.getTradeSymbolsReloadState(marketType);
    const marketLabel = isSpot(marketType) ? 'spot' : 'futures';

    // Join an in-flight reload — concurrent callers share one REST round-trip.
    if (state.inFlight !== null) {
      await state.inFlight;

      return;
    }

    // Cooldown: a recent reload already refreshed the full list — skip another REST hit
    // until the cooldown elapses.
    const sinceLastReloadMs = Date.now() - state.lastReloadMs;

    if (state.lastReloadMs > 0 && sinceLastReloadMs < TRADE_SYMBOLS_RELOAD_COOLDOWN_MS) {
      logger.warn(
        { exchange: this.exchangeName, marketType, reasonLabel, sinceLastReloadMs },
        `[ExchangeConnector] ${reasonLabel} but ${marketLabel} reload on cooldown (${Math.round(sinceLastReloadMs / 1000)}s since last) — skipping reload`
      );

      return;
    }

    const reloadPromise = (async (): Promise<void> => {
      logger.info(
        { exchange: this.exchangeName, marketType, reasonLabel },
        `[ExchangeConnector] ${reasonLabel} — reloading all ${marketLabel} trade symbols`
      );
      await withRetryOn429({
        fn: () => this.getClient(marketType).loadTradeSymbols(),
        contextLabel: `reload ${marketLabel} trade symbols (${reasonLabel}) ${this.exchangeName}`,
      });
    })();

    state.inFlight = reloadPromise;

    try {
      await reloadPromise;
      this.syncFollowerTradeSymbols(marketType);
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName, marketType, reasonLabel },
        `[ExchangeConnector] ${marketLabel} trade-symbol reload failed (${reasonLabel})`
      );
    } finally {
      state.lastReloadMs = Date.now();
      state.inFlight = null;
    }
  }

  /**
   * Refresh the instruments cache of BOTH markets — futures first, spot after, one at a time and
   * never in parallel: a scheduled round starts on every process of the account at the same
   * minute, and two reads fired together double the spike the exchange sees. A failure of either
   * market is logged and swallowed — the caller keeps the previous cache (stale beats empty) and
   * the second market is refreshed regardless of what happened to the first.
   */
  public async refreshAllTradeSymbols(reasonLabel: string = MANUAL_TRADE_SYMBOLS_REFRESH_REASON): Promise<void> {
    if (this.isRefreshingAllTradeSymbols) {
      logger.warn(
        { exchange: this.exchangeName, reasonLabel },
        `[ExchangeConnector] ${reasonLabel} skipped — the previous trade-symbol round has not finished yet`
      );

      return;
    }

    this.isRefreshingAllTradeSymbols = true;

    try {
      await this.refreshMarketTradeSymbolsSafely(MarketTypeEnum.Futures, reasonLabel);
      await this.refreshMarketTradeSymbolsSafely(MarketTypeEnum.Spot, reasonLabel);
      await this.loadFuturesLeverageTiers(reasonLabel);
    } finally {
      this.isRefreshingAllTradeSymbols = false;
    }
  }

  /**
   * Bulk read of the futures leverage tiers for every symbol. Single-flight; a failure is logged and
   * swallowed, and the previous map stays (an app without tiers falls back to its plain setting — the
   * behaviour it had before tiers existed — which beats a start that never happens).
   */
  public async loadFuturesLeverageTiers(reasonLabel: string): Promise<void> {
    if (this.marketDataPrimary !== null) {
      await this.marketDataPrimary.loadFuturesLeverageTiers(reasonLabel);

      return;
    }

    if (this.shouldSkipSignedLeverageTierRead()) {
      return;
    }

    // A joiner shares the read AND its outcome: the original caller logs a failure, the joiner just
    // sees the promise settle — a rejection reaching it would break the "never throws" contract.
    if (this.leverageTierBulkLoadInFlight !== null) {
      await this.leverageTierBulkLoadInFlight.catch(() => undefined);

      return;
    }

    const loadPromise = (async (): Promise<void> => {
      const tierListBySymbol = await withRetryOn429({
        fn: () => this.exchange.futures.fetchAllLeverageTierList(),
        contextLabel: `load leverage tiers (${reasonLabel}) ${this.exchangeName}`,
      });

      this.futuresLeverageTierListBySymbol.clear();

      for (const [symbol, tierList] of tierListBySymbol) {
        this.futuresLeverageTierListBySymbol.set(symbol, tierList);
      }

      this.leverageTierMissAtMsBySymbol.clear();
      logger.info(
        { exchange: this.exchangeName, reasonLabel, symbolCount: tierListBySymbol.size },
        `[ExchangeConnector] ${reasonLabel} — leverage tiers loaded for ${tierListBySymbol.size} futures symbols`
      );
    })();

    this.leverageTierBulkLoadInFlight = loadPromise;

    try {
      await loadPromise;
    } catch (error) {
      logger.error(
        { error, exchange: this.exchangeName, reasonLabel },
        `[ExchangeConnector] leverage-tier load failed (${reasonLabel}) — keeping the previous tiers`
      );
    } finally {
      this.leverageTierBulkLoadInFlight = null;
    }
  }

  /**
   * Make sure the tiers of ONE futures symbol are cached: a present entry costs nothing, a missing
   * one is fetched for that symbol alone (concurrent callers share the read). `isForced` re-reads a
   * present entry too — for an app that just got a refusal proving the cached table is stale. Returns
   * whether the symbol has tiers afterwards; a symbol the exchange answered empty for is not asked
   * again for LEVERAGE_TIER_SYMBOL_RELOAD_COOLDOWN_MS.
   */
  public async ensureFuturesLeverageTierListLoaded(symbol: string, isForced: boolean = false): Promise<boolean> {
    if (this.marketDataPrimary !== null) {
      return this.marketDataPrimary.ensureFuturesLeverageTierListLoaded(symbol, isForced);
    }

    if (!isForced && this.futuresLeverageTierListBySymbol.has(symbol)) {
      return true;
    }

    if (this.shouldSkipSignedLeverageTierRead()) {
      return false;
    }

    const inFlight = this.leverageTierSymbolLoadInFlightBySymbol.get(symbol);

    if (inFlight !== undefined) {
      await inFlight.catch(() => undefined);

      return this.futuresLeverageTierListBySymbol.has(symbol);
    }

    const missAtMs = this.leverageTierMissAtMsBySymbol.get(symbol);

    if (!isForced && missAtMs !== undefined && Date.now() - missAtMs < LEVERAGE_TIER_SYMBOL_RELOAD_COOLDOWN_MS) {
      return false;
    }

    const loadPromise = (async (): Promise<void> => {
      const tierList = await withRetryOn429({
        fn: () => this.exchange.futures.fetchLeverageTierList(symbol),
        contextLabel: `load leverage tiers ${symbol} ${this.exchangeName}`,
      });

      if (tierList.length === 0) {
        this.leverageTierMissAtMsBySymbol.set(symbol, Date.now());

        return;
      }

      this.futuresLeverageTierListBySymbol.set(symbol, tierList);
      this.leverageTierMissAtMsBySymbol.delete(symbol);
    })();

    this.leverageTierSymbolLoadInFlightBySymbol.set(symbol, loadPromise);

    try {
      await loadPromise;
    } catch (error) {
      this.leverageTierMissAtMsBySymbol.set(symbol, Date.now());
      logger.error(
        { error, exchange: this.exchangeName, symbol },
        `[ExchangeConnector] leverage-tier load for ${symbol} failed — the app keeps its plain leverage setting`
      );
    } finally {
      this.leverageTierSymbolLoadInFlightBySymbol.delete(symbol);
    }

    return this.futuresLeverageTierListBySymbol.has(symbol);
  }

  /** A keyless connector on an exchange with a signed tier read has no tiers; said once, at debug level. */
  private shouldSkipSignedLeverageTierRead(): boolean {
    if (!this.isKeyless || !SIGNED_LEVERAGE_TIER_EXCHANGE_NAME_SET.has(this.exchangeName)) {
      return false;
    }

    if (!this.isKeylessTierSkipLogged) {
      this.isKeylessTierSkipLogged = true;
      logger.debug(
        { exchange: this.exchangeName },
        `[ExchangeConnector] ${this.exchangeName} connector has no API key — the signed leverage-tier read is skipped (no tiers)`
      );
    }

    return true;
  }

  /** Cached futures leverage tiers of a symbol (ascending cap); null when the symbol has none cached. */
  public getFuturesLeverageTierList(symbol: string): LeverageTier[] | null {
    if (this.marketDataPrimary !== null) {
      return this.marketDataPrimary.getFuturesLeverageTierList(symbol);
    }

    return this.futuresLeverageTierListBySymbol.get(symbol) ?? null;
  }

  private async refreshMarketTradeSymbolsSafely(marketType: MarketTypeEnum, reasonLabel: string): Promise<void> {
    try {
      if (isSpot(marketType)) {
        await this.reloadSpotTradeSymbols(reasonLabel);

        return;
      }

      await this.reloadFuturesTradeSymbols(reasonLabel);
    } catch (error) {
      logger.warn(
        { error, exchange: this.exchangeName, marketType, reasonLabel },
        `[ExchangeConnector] ${reasonLabel} failed for ${isSpot(marketType) ? 'spot' : 'futures'} — keeping the previous cache`
      );
    }
  }

  /**
   * Arm the daily instruments refresh. Called at the end of a successful initialize(), so a
   * repeated initialize() re-arms the schedule instead of leaving two timers behind. An interval
   * of 0 (or less) means the consumer refreshes by hand — nothing is scheduled.
   */
  private startDailyTradeSymbolsRefresh(): void {
    this.stopDailyTradeSymbolsRefresh();

    if (this.tradeSymbolsRefreshIntervalMs <= 0) {
      logger.info(
        { exchange: this.exchangeName },
        `[ExchangeConnector] ${this.exchangeName} daily trade-symbol refresh is switched off by config`
      );

      return;
    }

    this.isTradeSymbolsRefreshScheduled = true;
    this.scheduleNextTradeSymbolsRefresh();
  }

  private stopDailyTradeSymbolsRefresh(): void {
    this.isTradeSymbolsRefreshScheduled = false;

    if (this.tradeSymbolsRefreshTimeoutId !== null) {
      clearTimeout(this.tradeSymbolsRefreshTimeoutId);
      this.tradeSymbolsRefreshTimeoutId = null;
    }
  }

  private scheduleNextTradeSymbolsRefresh(): void {
    const delayMs = this.resolveTradeSymbolsRefreshDelayMs();

    logger.info(
      { exchange: this.exchangeName, delayMs },
      `[ExchangeConnector] ${this.exchangeName} next trade-symbol refresh in ${Math.round(delayMs / 1000)}s`
    );

    const timeoutId = setTimeout(() => {
      this.tradeSymbolsRefreshTimeoutId = null;

      void this.runScheduledTradeSymbolsRefresh();
    }, delayMs);

    // The schedule must never be the reason a process stays alive.
    timeoutId.unref();
    this.tradeSymbolsRefreshTimeoutId = timeoutId;
  }

  // The next round is armed only AFTER this one has settled, so a slow reload can never overlap
  // with the following tick; a disconnect during the round leaves nothing armed.
  private async runScheduledTradeSymbolsRefresh(): Promise<void> {
    await this.refreshAllTradeSymbols(DAILY_TRADE_SYMBOLS_REFRESH_REASON);

    if (!this.isTradeSymbolsRefreshScheduled) {
      return;
    }

    this.scheduleNextTradeSymbolsRefresh();
  }

  /**
   * How long to wait for the next round. The 24-hour schedule is pinned to the next 00:05 UTC,
   * recomputed from the clock every round so the random shift never drifts the anchor away; any
   * other interval is taken literally, because 00:05 means nothing to it.
   */
  private resolveTradeSymbolsRefreshDelayMs(): number {
    if (this.tradeSymbolsRefreshIntervalMs !== TRADE_SYMBOLS_REFRESH_DAY_MS) {
      return this.tradeSymbolsRefreshIntervalMs;
    }

    const nowMs = Date.now();
    const anchor = new Date(nowMs);

    anchor.setUTCHours(TRADE_SYMBOLS_REFRESH_UTC_HOUR, TRADE_SYMBOLS_REFRESH_UTC_MINUTE, 0, 0);

    let delayMs = anchor.getTime() - nowMs;

    while (delayMs <= 0) {
      delayMs += TRADE_SYMBOLS_REFRESH_DAY_MS;
    }

    return delayMs + Math.floor(Math.random() * TRADE_SYMBOLS_REFRESH_JITTER_MAX_MS);
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
    if (this.marketDataPrimary !== null) {
      const followerIndex = this.marketDataPrimary.marketDataFollowerList.indexOf(this);

      if (followerIndex !== -1) {
        this.marketDataPrimary.marketDataFollowerList.splice(followerIndex, 1);
      }
    }

    this.isWatchingTickers = false;
    this.stopWatchingMarkPrices();
    this.stopDailyTradeSymbolsRefresh();

    for (const tracker of this.orderBookTrackerByMarketType.values()) {
      tracker.stop();
    }

    this.orderBookTrackerByMarketType.clear();

    for (const router of this.userDataStreamRouterByMarketType.values()) {
      router.disconnect();
    }

    this.userDataStreamRouterByMarketType.clear();

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
