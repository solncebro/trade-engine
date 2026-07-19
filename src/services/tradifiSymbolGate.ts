import type { TradifiSymbolGateArgs, TradifiSymbolGateConnector } from './tradifiSymbolGate.types';

import { logger } from '../core/logger';

/** A symbol classified as outside the universe is re-checked after this long, so a brand-new
 *  listing that hit the symbol-cache reload cooldown is not blocked until the next restart. */
const BLOCKED_CLASSIFICATION_TTL_MS = 60 * 60 * 1000;

/**
 * The reusable non-TradFi symbol universe: one place that answers "may this symbol be traded /
 * served" by the excludeTradifi rule (tokenized stocks, ETFs, commodities are out by default).
 * A consuming app that actually wants TradFi passes shouldAllowTradifi: true to lift the filter — the
 * default keeps TradFi out. Consumers keep
 * a cached allowed-set; an unknown symbol goes through classify(), which refreshes the exchange
 * symbol cache ONCE for all concurrent unknowns (the connector's own cooldown guards the REST call)
 * and remembers a negative verdict for an hour, so a TradFi symbol streaming klines does not
 * hammer the exchange with reload attempts.
 */
export class TradifiSymbolGate {
  private readonly connector: TradifiSymbolGateConnector;
  /** When true, the universe keeps TradFi symbols in (filter lifted); default false keeps them out. */
  private readonly shouldAllowTradifi: boolean;

  private allowedSymbolSet = new Set<string>();
  private readonly blockedUntilMsBySymbol = new Map<string, number>();
  private classificationInFlight: Promise<void> | null = null;

  constructor(args: TradifiSymbolGateArgs) {
    this.connector = args.connector;
    this.shouldAllowTradifi = args.shouldAllowTradifi === true;
  }

  /** Load the universe and refuse to start with everything blocked — an empty read at startup
   *  means the exchange symbol cache itself is broken, not that the market is empty. */
  async initialize(): Promise<void> {
    const universeList = await this.loadUniverse();

    if (universeList.length === 0) {
      throw new Error('[TradifiSymbolGate] allowed symbol universe came back empty — refusing to run with every symbol blocked');
    }

    logger.info({ symbolCount: universeList.length }, `[TradifiSymbolGate] allowed universe loaded — ${universeList.length} symbols`);
  }

  /** Read the tradifi-free list from the connector's cache (no REST refresh). Returns the raw
   *  read; the internal allowed-set only advances on a non-empty read (an empty read means the
   *  list fetch failed — stale is better than blocking everything). */
  async loadUniverse(): Promise<string[]> {
    const universeList = await this.connector.getFuturesSymbols({ excludeTradifi: !this.shouldAllowTradifi });

    if (universeList.length > 0) this.allowedSymbolSet = new Set(universeList);

    return universeList;
  }

  /** Refresh the exchange symbol cache first (listings/delistings become visible), then read. */
  async reloadUniverse(): Promise<string[]> {
    await this.connector.refreshFuturesTradeSymbols();

    return this.loadUniverse();
  }

  isAllowed(symbol: string): boolean {
    return this.allowedSymbolSet.has(symbol);
  }

  isBlocked(symbol: string): boolean {
    const blockedUntilMs = this.blockedUntilMsBySymbol.get(symbol);

    if (blockedUntilMs === undefined) return false;

    if (Date.now() < blockedUntilMs) return true;

    this.blockedUntilMsBySymbol.delete(symbol);

    return false;
  }

  /** Classify an unknown symbol: one shared refresh+reload for all concurrent unknowns, then a
   *  fresh allowed-set lookup. A negative verdict is remembered (see BLOCKED_CLASSIFICATION_TTL_MS). */
  async classify(symbol: string): Promise<boolean> {
    if (this.isAllowed(symbol)) return true;

    if (this.isBlocked(symbol)) return false;

    this.classificationInFlight ??= this.runClassificationReload();

    await this.classificationInFlight;

    if (this.isAllowed(symbol)) return true;

    this.blockedUntilMsBySymbol.set(symbol, Date.now() + BLOCKED_CLASSIFICATION_TTL_MS);
    logger.warn({ symbol }, `[TradifiSymbolGate] ${symbol}: outside the tradable universe (TradFi or unlisted) — blocked`);

    return false;
  }

  classifyInBackground(symbol: string): void {
    this.classify(symbol).catch((error: unknown) => logger.error({ symbol, error }, `[TradifiSymbolGate] ${symbol}: classification failed`));
  }

  getAllowedSymbolList(): string[] {
    return [...this.allowedSymbolSet];
  }

  filterSymbolList(symbolList: string[]): string[] {
    return symbolList.filter((symbol) => this.isAllowed(symbol));
  }

  private async runClassificationReload(): Promise<void> {
    try {
      await this.reloadUniverse();
    } catch (error) {
      logger.error({ error }, '[TradifiSymbolGate] symbol universe refresh failed — keeping the previous universe');
    } finally {
      this.classificationInFlight = null;
    }
  }
}
