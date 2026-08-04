import { EventEmitter } from 'events';

import { logger } from './logger';
import type { MarketDataSource } from './marketDataSource.types';
import { TrendCalculator } from './trendCalculator';
import type {
  TrendAssessmentResult,
  TrendDirection,
} from './trendCalculator.types';
import type {
  TrendChangedListener,
  TrendMonitorArgs,
  TrendSummary,
} from './TrendMonitor.types';

import type { KlineInterval } from '../types/index';
import { selectClosedKlineList } from '../utils/klineList';

interface TrendMonitorListenerRef {
  onKlineClosed: (symbol: string) => void;
  onSymbolAdded: (symbol: string) => void;
  onSymbolRemoved: (symbol: string) => void;
}

class TrendMonitor extends EventEmitter {
  private readonly marketDataManagerByInterval: Map<
    KlineInterval,
    MarketDataSource
  >;
  private readonly config: TrendMonitorArgs['config'];
  private readonly resultByInterval: Map<
    KlineInterval,
    Map<string, TrendAssessmentResult>
  > = new Map();
  private readonly listenerRefByManager: Map<
    MarketDataSource,
    TrendMonitorListenerRef
  > = new Map();
  private isStarted = false;

  constructor(args: TrendMonitorArgs) {
    super();
    this.marketDataManagerByInterval = args.marketDataManagerByInterval;
    this.config = args.config;
  }

  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;

    for (const [interval, manager] of this.marketDataManagerByInterval) {
      this.initializeIntervalCache(interval, manager);
      this.subscribeToMarketDataManager(interval, manager);
    }
  }

  stop(): void {
    for (const manager of [...this.listenerRefByManager.keys()]) {
      this.unsubscribeManager(manager);
    }

    this.resultByInterval.clear();
    this.isStarted = false;
  }

  attachMarketDataManager(
    interval: KlineInterval,
    marketDataManager: MarketDataSource
  ): void {
    const previousManager = this.marketDataManagerByInterval.get(interval);

    if (
      previousManager !== undefined &&
      previousManager !== marketDataManager
    ) {
      this.unsubscribeManager(previousManager);
    }

    this.marketDataManagerByInterval.set(interval, marketDataManager);

    if (!this.isStarted) {
      return;
    }

    this.initializeIntervalCache(interval, marketDataManager);
    this.subscribeToMarketDataManager(interval, marketDataManager);
  }

  getTrend(
    symbol: string,
    interval: KlineInterval
  ): TrendAssessmentResult | undefined {
    return this.resultByInterval.get(interval)?.get(symbol);
  }

  getTrendSummary(symbol: string): TrendSummary {
    const byInterval = new Map<
      KlineInterval,
      TrendAssessmentResult | undefined
    >();

    for (const interval of this.marketDataManagerByInterval.keys()) {
      byInterval.set(
        interval,
        this.resultByInterval.get(interval)?.get(symbol)
      );
    }

    return {
      byInterval,
      alignedDirection: this.resolveAlignedDirection(byInterval),
    };
  }

  on(eventName: 'trendChanged', listener: TrendChangedListener): this {
    return super.on(eventName, listener);
  }

  off(eventName: 'trendChanged', listener: TrendChangedListener): this {
    return super.off(eventName, listener);
  }

  private getOrCreateResultBySymbol(
    interval: KlineInterval
  ): Map<string, TrendAssessmentResult> {
    let resultBySymbol = this.resultByInterval.get(interval);

    if (resultBySymbol === undefined) {
      resultBySymbol = new Map();
      this.resultByInterval.set(interval, resultBySymbol);
    }

    return resultBySymbol;
  }

  private initializeIntervalCache(
    interval: KlineInterval,
    manager: MarketDataSource
  ): void {
    for (const symbol of manager.getSymbolList()) {
      this.updateSymbol(interval, symbol, false);
    }
  }

  private subscribeToMarketDataManager(
    interval: KlineInterval,
    manager: MarketDataSource
  ): void {
    if (this.listenerRefByManager.has(manager)) {
      return;
    }

    const listenerRef: TrendMonitorListenerRef = {
      onKlineClosed: symbol => this.updateSymbol(interval, symbol, true),
      onSymbolAdded: symbol => this.updateSymbol(interval, symbol, false),
      onSymbolRemoved: symbol => this.removeSymbol(interval, symbol),
    };

    manager.on('klineClosed', listenerRef.onKlineClosed);
    manager.on('symbolAdded', listenerRef.onSymbolAdded);
    manager.on('symbolRemoved', listenerRef.onSymbolRemoved);

    this.listenerRefByManager.set(manager, listenerRef);
  }

  private unsubscribeManager(manager: MarketDataSource): void {
    const listenerRef = this.listenerRefByManager.get(manager);

    if (listenerRef === undefined) {
      return;
    }

    manager.off('klineClosed', listenerRef.onKlineClosed);
    manager.off('symbolAdded', listenerRef.onSymbolAdded);
    manager.off('symbolRemoved', listenerRef.onSymbolRemoved);
    this.listenerRefByManager.delete(manager);
  }

  private updateSymbol(
    interval: KlineInterval,
    symbol: string,
    canEmit: boolean
  ): void {
    const manager = this.marketDataManagerByInterval.get(interval);

    if (manager === undefined) {
      return;
    }

    const resultBySymbol = this.getOrCreateResultBySymbol(interval);

    let result: TrendAssessmentResult;

    try {
      const closedKlineList = selectClosedKlineList(
        manager.getKlineList(symbol)
      );
      result = TrendCalculator.assessTrend({
        klineList: closedKlineList,
        config: this.config,
      });
    } catch (error) {
      logger.error(
        { error, symbol, interval },
        `[TrendMonitor] ${symbol} assessTrend failed [${interval}]`
      );

      return;
    }

    const previousResult = resultBySymbol.get(symbol);
    resultBySymbol.set(symbol, result);

    if (!canEmit || previousResult === undefined) {
      return;
    }

    if (previousResult.kind !== 'assessed' || result.kind !== 'assessed') {
      return;
    }

    if (previousResult.assessment.direction === result.assessment.direction) {
      return;
    }

    this.emit('trendChanged', {
      symbol,
      interval,
      previousDirection: previousResult.assessment.direction,
      currentDirection: result.assessment.direction,
      result,
    });
  }

  private removeSymbol(interval: KlineInterval, symbol: string): void {
    this.resultByInterval.get(interval)?.delete(symbol);
  }

  private resolveAlignedDirection(
    byInterval: Map<KlineInterval, TrendAssessmentResult | undefined>
  ): TrendDirection | null {
    let alignedDirection: TrendDirection | null = null;

    for (const result of byInterval.values()) {
      if (result === undefined || result.kind !== 'assessed') {
        return null;
      }

      if (alignedDirection === null) {
        alignedDirection = result.assessment.direction;

        continue;
      }

      if (alignedDirection !== result.assessment.direction) {
        return null;
      }
    }

    return alignedDirection;
  }
}

export { TrendMonitor };
