import { ExchangeNameEnum } from '@solncebro/exchange-engine';
import type { OrderBookHandler, OrderBookLevel, OrderBookRawLevel, OrderBookUpdate } from '@solncebro/exchange-engine';

import type { LiveOrderBook, OrderBookTrackerArgs } from './orderBookTracker.types';

import { logger } from '../core/logger';

// Partial-depth streams are served at fixed sizes: Binance futures at 5/10/20 levels per
// side (a full ready-made slice every 100 ms), Bybit linear at 1/50/200/500/1000 (a snapshot
// followed by deltas). One consumer-facing default per exchange keeps the choice out of
// every application; a symbol thin enough to need more than this is not one to close in a
// single piece anyway.
const ORDER_BOOK_STREAM_DEPTH_BY_EXCHANGE: ReadonlyMap<ExchangeNameEnum, number> = new Map([
  [ExchangeNameEnum.Binance, 20],
  [ExchangeNameEnum.Bybit, 50],
]);
const FALLBACK_ORDER_BOOK_STREAM_DEPTH = 50;
const DEFAULT_RESUBSCRIBE_DEBOUNCE_MS = 5_000;

/** The stream depth `OrderBookTracker` subscribes at for the given exchange. */
function resolveOrderBookStreamDepth(exchangeName: ExchangeNameEnum): number {
  return ORDER_BOOK_STREAM_DEPTH_BY_EXCHANGE.get(exchangeName) ?? FALLBACK_ORDER_BOOK_STREAM_DEPTH;
}

interface TrackedBook {
  askList: OrderBookLevel[];
  bidList: OrderBookLevel[];
  updateId: number;
  eventTimestamp: number;
  receivedTimestamp: number;
}

// Binary search over a side sorted by price (ascending asks, descending bids): the exact index
// when the price is present, otherwise the insertion index that keeps the order.
function locateLevel(levelList: OrderBookLevel[], price: number, isDescending: boolean): { index: number; isFound: boolean } {
  let low = 0;
  let high = levelList.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const middlePrice = levelList[middle].price;

    if (middlePrice === price) {
      return { index: middle, isFound: true };
    }

    const isRightward = isDescending ? middlePrice > price : middlePrice < price;

    if (isRightward) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return { index: low, isFound: false };
}

// One delta level: zero quantity removes the level, a known price updates it in place, a new
// price is inserted at its sorted position.
function applyDeltaLevel(levelList: OrderBookLevel[], rawLevel: OrderBookRawLevel, isDescending: boolean): void {
  const price = parseFloat(rawLevel[0]);
  const quantity = parseFloat(rawLevel[1]);

  if (!Number.isFinite(price)) {
    return;
  }

  const { index, isFound } = locateLevel(levelList, price, isDescending);

  if (!(quantity > 0)) {
    if (isFound) {
      levelList.splice(index, 1);
    }

    return;
  }

  if (isFound) {
    levelList[index].quantity = quantity;

    return;
  }

  levelList.splice(index, 0, { price, quantity });
}

// A snapshot side: parse, drop empty levels, and sort defensively (exchanges send the side
// sorted already, but the merge below relies on the order and a re-sort of ≤200 levels is free).
function buildSortedLevelList(rawLevelList: ReadonlyArray<OrderBookRawLevel>, isDescending: boolean): OrderBookLevel[] {
  const levelList: OrderBookLevel[] = [];

  for (const [priceText, quantityText] of rawLevelList) {
    const price = parseFloat(priceText);
    const quantity = parseFloat(quantityText);

    if (Number.isFinite(price) && quantity > 0) {
      levelList.push({ price, quantity });
    }
  }

  levelList.sort((first, second) => (isDescending ? second.price - first.price : first.price - second.price));

  return levelList;
}

/**
 * Keeps a live, merged order book per subscribed symbol so a consumer can read depth
 * synchronously (`getBook`) instead of polling the REST endpoint. Subscriptions are
 * reference-counted: the stream topic opens on the first `subscribe` of a symbol and closes
 * on the last `unsubscribe`. Frames are merged per exchange format — a Binance partial-depth
 * frame is a complete slice and replaces the book, a Bybit stream sends one snapshot and
 * then deltas applied level by level. A gap in the Bybit delta sequence means a lost delta
 * and a drifted book: the book is dropped (readers see `null` until the fresh snapshot
 * lands) and the topic is resubscribed, debounced per symbol.
 */
class OrderBookTracker {
  private readonly client: OrderBookTrackerArgs['client'];
  private readonly depth: number;
  private readonly clientLabel: string;
  private readonly resubscribeDebounceMs: number;
  private readonly now: () => number;
  private readonly referenceCountBySymbol: Map<string, number> = new Map();
  private readonly bookBySymbol: Map<string, TrackedBook> = new Map();
  private readonly lastResubscribeAtBySymbol: Map<string, number> = new Map();
  // One handler for every symbol: the connector proxy keys wrapped handlers by topic, and
  // the raw streams store handlers by reference, so the same ref must be used to unsubscribe.
  private readonly handler: OrderBookHandler = (symbol, update): void => {
    this.applyUpdate(symbol, update);
  };

  public constructor(args: OrderBookTrackerArgs) {
    this.client = args.client;
    this.depth = args.depth;
    this.clientLabel = args.clientLabel;
    this.resubscribeDebounceMs = args.resubscribeDebounceMs ?? DEFAULT_RESUBSCRIBE_DEBOUNCE_MS;
    this.now = args.now ?? ((): number => Date.now());
  }

  public get streamDepth(): number {
    return this.depth;
  }

  /** Opens the stream topic on the first call for a symbol; later calls only count. Throws when the market has no order book stream. */
  public subscribe(symbol: string): void {
    const count = this.referenceCountBySymbol.get(symbol) ?? 0;

    if (count === 0) {
      this.client.subscribeOrderbook({ symbol, depth: this.depth, handler: this.handler });
    }

    this.referenceCountBySymbol.set(symbol, count + 1);
  }

  /** Closes the topic when the last subscriber leaves; the book is forgotten with it. */
  public unsubscribe(symbol: string): void {
    const count = this.referenceCountBySymbol.get(symbol) ?? 0;

    if (count === 0) {
      return;
    }

    if (count > 1) {
      this.referenceCountBySymbol.set(symbol, count - 1);

      return;
    }

    this.referenceCountBySymbol.delete(symbol);
    this.bookBySymbol.delete(symbol);
    this.lastResubscribeAtBySymbol.delete(symbol);

    try {
      this.client.unsubscribeOrderbook({ symbol, depth: this.depth, handler: this.handler });
    } catch (error) {
      logger.warn({ error, symbol, clientLabel: this.clientLabel }, '[OrderBookTracker] unsubscribe failed');
    }
  }

  public isSubscribed(symbol: string): boolean {
    return this.referenceCountBySymbol.has(symbol);
  }

  public getSubscribedSymbolList(): string[] {
    return [...this.referenceCountBySymbol.keys()];
  }

  /** The merged book, or null when the symbol is not subscribed, no snapshot arrived yet, or the sequence broke and the fresh snapshot is still on its way. */
  public getBook(symbol: string): LiveOrderBook | null {
    const book = this.bookBySymbol.get(symbol);

    if (book === undefined) {
      return null;
    }

    return {
      symbol,
      askList: book.askList.map(level => ({ ...level })),
      bidList: book.bidList.map(level => ({ ...level })),
      updateId: book.updateId,
      eventTimestamp: book.eventTimestamp,
      receivedTimestamp: book.receivedTimestamp,
    };
  }

  /** Drops every subscription (process shutdown). */
  public stop(): void {
    for (const symbol of [...this.referenceCountBySymbol.keys()]) {
      this.referenceCountBySymbol.set(symbol, 1);
      this.unsubscribe(symbol);
    }
  }

  private applyUpdate(symbol: string, update: OrderBookUpdate): void {
    // A frame that outlives its subscription (in flight during unsubscribe) must not resurrect the book.
    if (!this.referenceCountBySymbol.has(symbol)) {
      return;
    }

    const previous = this.bookBySymbol.get(symbol);

    if (update.updateType === 'snapshot') {
      this.bookBySymbol.set(symbol, {
        askList: buildSortedLevelList(update.askList, false),
        bidList: buildSortedLevelList(update.bidList, true),
        updateId: update.updateId,
        eventTimestamp: update.eventTimestamp,
        receivedTimestamp: update.receivedTimestamp,
      });

      return;
    }

    // A delta without a base is meaningless (the stream always opens with a snapshot).
    if (previous === undefined) {
      return;
    }

    if (update.updateId !== previous.updateId + 1) {
      this.handleSequenceGap(symbol, previous.updateId, update.updateId);

      return;
    }

    for (const rawLevel of update.askList) {
      applyDeltaLevel(previous.askList, rawLevel, false);
    }

    for (const rawLevel of update.bidList) {
      applyDeltaLevel(previous.bidList, rawLevel, true);
    }

    previous.updateId = update.updateId;
    previous.eventTimestamp = update.eventTimestamp;
    previous.receivedTimestamp = update.receivedTimestamp;
  }

  private handleSequenceGap(symbol: string, expectedUpdateId: number, receivedUpdateId: number): void {
    // A drifted book is worse than no book: readers fall back to a REST read until the
    // fresh snapshot arrives.
    this.bookBySymbol.delete(symbol);

    const nowMs = this.now();
    const lastResubscribeAt = this.lastResubscribeAtBySymbol.get(symbol) ?? 0;

    if (nowMs - lastResubscribeAt < this.resubscribeDebounceMs) {
      logger.warn(
        { symbol, expectedUpdateId, receivedUpdateId, clientLabel: this.clientLabel },
        '[OrderBookTracker] sequence gap — resubscribe debounced'
      );

      return;
    }

    this.lastResubscribeAtBySymbol.set(symbol, nowMs);
    logger.warn(
      { symbol, expectedUpdateId, receivedUpdateId, clientLabel: this.clientLabel },
      '[OrderBookTracker] sequence gap — resubscribing for a fresh snapshot'
    );

    try {
      this.client.resubscribeOrderbook({ symbol, depth: this.depth });
    } catch (error) {
      logger.error({ error, symbol, clientLabel: this.clientLabel }, '[OrderBookTracker] resubscribe failed');
    }
  }
}

export { OrderBookTracker, resolveOrderBookStreamDepth };
