import { logger } from './logger';
import { LogThrottle } from './logThrottle';
import type { MarketDataSource } from './marketDataSource.types';
import type { OrderManager } from './OrderManager';
import type { ExternalMultiEntryCancelBufferEntry, ImportFibPositionArgs, MultiOrderTimeoutNotifyArgs, PlaceFibBreakevenExitArgs, PlaceFibTakeProfitArgs, PositionMonitorArgs, PositionRemovedExternallyNotifyArgs, StopLossStatus, TpSplitOrderPlacementArgs, TpSplitOrderPlacementResult } from './PositionMonitor.types';
import type { PositionStore } from './positionStore.types';

import type { ExchangeConnector } from '../services/exchangeConnector';
import type { Kline, KlineInterval, MaLevel, MonitoredPosition, OrderUpdateEvent, Position, PositionModeEnum, PositionUpdateEvent } from '../types/index';
import { ALL_SUPPORTED_INTERVAL_LIST, MarketTypeEnum } from '../types/index';
import { computeBreakevenLadder } from '../utils/breakevenLadder';
import { extractKlineHighLowSnapshot, resolveFavourableDecisionPrice, resolveUnfavourableDecisionPrice } from '../utils/entryKlineGuard';
import { calculatePercentChange } from '../utils/indicators';
import type { IntervalSchedulerHandle } from '../utils/intervalScheduler';
import { applyLegacyDefaults } from '../utils/legacyDefaults';

const PNL_POLL_INTERVAL_MS = 15_000;
const STOP_LOSS_ERROR_TEXT_MAX_LENGTH = 150;
const MIN_STOP_LOSS_LEVEL = 0.5;
const EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT = 2;
const BOT_CANCEL_SUPPRESS_MS = 30_000;
const WS_UPDATE_LOG_THROTTLE_MS = 60_000;
const POSITIONS_SCAN_THROTTLE_MS = 2_000;
const IMPORTED_POSITION_TIMEFRAME: KlineInterval = '30m';
const IMPORTED_POSITION_MA_LEVEL: MaLevel = 200;

const POSITION_LEGACY_DEFAULTS: Partial<MonitoredPosition> = {
  insuranceFailReason: null,
  stopLossLastErrorText: null,
  tpOrderIdList: null,
  multiEntryOrderIdList: null,
  primaryOrderCount: 1,
  primarySpreadPercent: null,
  primaryAvgVolumeOffsetPercent: null,
  plannedNotionalUsdt: 0,
  lastFillKlineOpenTimestamp: null,
  entryKlineHighSnapshot: null,
  entryKlineLowSnapshot: null,
  halveEnableKlineHighSnapshot: null,
  halveEnableKlineLowSnapshot: null,
  halveEnableKlineOpenTimestamp: null,
  isHalveAtBreakevenEnabled: false,
  hasInsuranceCycleCompleted: false,
  isInsuranceUnavailableNotified: false,
  isAugmented: false,
  isTrailingSlEnabled: true,
  isPnlAlertsEnabled: true,
  isAutoCloseEnabled: true,
  isImported: false,
};

class PositionMonitor {
  protected readonly exchangeConnector: ExchangeConnector;
  protected readonly orderManager: OrderManager;
  protected readonly marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  protected readonly positionMode: PositionModeEnum;
  protected readonly positionStore: PositionStore;
  protected positionById: Map<string, MonitoredPosition> = new Map();
  protected pollSchedulerHandle: IntervalSchedulerHandle | null = null;
  protected readonly lastPriceBySymbol: Map<string, number> = new Map();
  protected readonly isReactiveCheckBusyByPositionId: Set<string> = new Set();
  protected readonly isStopLossUpdateInProgressByPositionId: Set<string> = new Set();
  protected readonly consecutiveClosedPollTickCountByPositionId: Map<string, number> = new Map();
  protected readonly botCancelledMultiEntryOrderIdExpiryMap: Map<string, number> = new Map();
  protected readonly externalCancelBufferByPositionId: Map<string, ExternalMultiEntryCancelBufferEntry> = new Map();
  protected externalCancelFlushTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly lastReadStateKindByPositionId: Map<string, string> = new Map();
  protected readonly logThrottle: LogThrottle = new LogThrottle();
  protected readonly ephemeralPositionByKey: Map<string, Position> = new Map();
  protected lastPositionsScanAtMs: number = 0;
  protected isPositionsScanInProgress: boolean = false;
  protected onPositionRemoved: ((positionId: string) => void) | null = null;

  constructor(args: PositionMonitorArgs) {
    this.exchangeConnector = args.exchangeConnector;
    this.orderManager = args.orderManager;
    this.marketDataManagerByInterval = args.marketDataManagerByInterval;
    this.positionMode = args.positionMode;
    this.positionStore = args.positionStore;
  }

  protected calculatePnlPercent(position: MonitoredPosition, lastPrice: number): number {
    if (position.direction === 'long') {
      return calculatePercentChange(lastPrice, position.entryPrice);
    }

    return calculatePercentChange(position.entryPrice, lastPrice);
  }

  protected computeKlineOpenTimestamp(timeframe: KlineInterval, nowMs: number): number | null {
    const marketDataManager = this.marketDataManagerByInterval.get(timeframe);

    if (!marketDataManager || typeof marketDataManager.getIntervalMs !== 'function') {
      return null;
    }

    const intervalMs = marketDataManager.getIntervalMs();

    if (intervalMs === undefined || intervalMs <= 0) {
      return null;
    }

    return Math.floor(nowMs / intervalMs) * intervalMs;
  }

  protected getLastPriceFromKline(symbol: string): number {
    const realtimeValue = this.lastPriceBySymbol.get(symbol);

    if (realtimeValue !== undefined && realtimeValue > 0 && Number.isFinite(realtimeValue)) {
      return realtimeValue;
    }

    for (const marketDataManager of this.marketDataManagerByInterval.values()) {
      if (typeof marketDataManager.getKlineList !== 'function') {
        continue;
      }

      const klineList = marketDataManager.getKlineList(symbol);
      const lastKline = klineList.at(-1);

      if (lastKline && lastKline.closePrice > 0 && Number.isFinite(lastKline.closePrice)) {
        return lastKline.closePrice;
      }
    }

    logger.warn({ symbol }, `[PnlMonitor] ${symbol} No lastPrice available — neither realtime Map nor kline buffer has data, returning 0`);

    return 0;
  }

  protected getLatestKline(symbol: string): Kline | null {
    for (const marketDataManager of this.marketDataManagerByInterval.values()) {
      if (typeof marketDataManager.getKlineList !== 'function') {
        continue;
      }

      const klineList = marketDataManager.getKlineList(symbol);
      const lastKline = klineList.at(-1);

      if (lastKline) {
        return lastKline;
      }
    }

    return null;
  }

  protected getLatestKlineForTimeframe(symbol: string, timeframe: KlineInterval): Kline | null {
    const marketDataManager = this.marketDataManagerByInterval.get(timeframe);

    if (!marketDataManager || typeof marketDataManager.getKlineList !== 'function') {
      return null;
    }

    const klineList = marketDataManager.getKlineList(symbol);
    const lastKline = klineList.at(-1);

    return lastKline ?? null;
  }

  protected captureEntryKlineSnapshot(symbol: string, timeframe: KlineInterval): { high: number | null; low: number | null } {
    return extractKlineHighLowSnapshot(this.getLatestKlineForTimeframe(symbol, timeframe));
  }

  protected getFavourableExtremePrice(symbol: string, direction: 'long' | 'short'): number {
    const lastKline = this.getLatestKline(symbol);
    const fallbackPrice = this.getLastPriceFromKline(symbol);

    if (!lastKline) {
      return fallbackPrice;
    }

    const extreme = direction === 'long' ? lastKline.highPrice : lastKline.lowPrice;

    if (!Number.isFinite(extreme) || extreme <= 0) {
      return fallbackPrice;
    }

    return extreme;
  }

  protected getUnfavourableExtremePrice(symbol: string, direction: 'long' | 'short'): number {
    const lastKline = this.getLatestKline(symbol);
    const fallbackPrice = this.getLastPriceFromKline(symbol);

    if (!lastKline) {
      return fallbackPrice;
    }

    const extreme = direction === 'long' ? lastKline.lowPrice : lastKline.highPrice;

    if (!Number.isFinite(extreme) || extreme <= 0) {
      return fallbackPrice;
    }

    return extreme;
  }

  protected computeDecisionPnlPercents(position: MonitoredPosition, pnlPercent: number, lastPrice: number): { favourable: number; unfavourable: number } {
    const lastKline = this.getLatestKlineForTimeframe(position.symbol, position.timeframe);

    if (!lastKline) {
      return { favourable: pnlPercent, unfavourable: pnlPercent };
    }

    const guard = {
      klineOpenTimestamp: this.computeKlineOpenTimestamp(position.timeframe, position.createdAt),
      highSnapshot: position.entryKlineHighSnapshot ?? null,
      lowSnapshot: position.entryKlineLowSnapshot ?? null,
    };

    const favourablePrice = resolveFavourableDecisionPrice({
      kline: lastKline,
      direction: position.direction,
      guard,
      offCandlePrice: this.getFavourableExtremePrice(position.symbol, position.direction),
      onCandleFallbackPrice: lastPrice,
    });
    const unfavourablePrice = resolveUnfavourableDecisionPrice({
      kline: lastKline,
      direction: position.direction,
      guard,
      offCandlePrice: this.getUnfavourableExtremePrice(position.symbol, position.direction),
      onCandleFallbackPrice: lastPrice,
    });

    return {
      favourable: this.calculatePnlPercent(position, favourablePrice),
      unfavourable: this.calculatePnlPercent(position, unfavourablePrice),
    };
  }

  getPositionListByDirection(direction: 'long' | 'short'): MonitoredPosition[] {
    const positionList: MonitoredPosition[] = [];

    for (const position of this.positionById.values()) {
      if (position.direction === direction) {
        positionList.push(position);
      }
    }

    return positionList;
  }

  getPositionById(id: string): MonitoredPosition | undefined {
    return this.positionById.get(id);
  }

  setOnPositionRemoved(callback: (positionId: string) => void): void {
    this.onPositionRemoved = callback;
  }

  protected async safeUpdateMonitoredPosition(positionId: string, partial: Partial<MonitoredPosition>): Promise<void> {
    if (!this.positionById.has(positionId)) {
      logger.warn(
        { positionId, fieldList: Object.keys(partial) },
        `[PnlMonitor] safeUpdateMonitoredPosition skipped — position ${positionId} not in RAM (likely removed). Preventing zombie Firestore write. fields=${Object.keys(partial).join(',')}`,
      );

      return;
    }

    await this.positionStore.updateMonitoredPosition(positionId, partial);
  }

  protected calculateStopLossPrice(position: MonitoredPosition, stopLossLevel: number): number {
    if (position.direction === 'long') {
      return position.entryPrice * (1 + stopLossLevel / 100);
    }

    return position.entryPrice * (1 - stopLossLevel / 100);
  }

  protected markBotCancelledMultiEntries(orderIdList: string[]): void {
    const nowMs = Date.now();
    const expiryMs = nowMs + BOT_CANCEL_SUPPRESS_MS;

    // Opportunistic prune of expired entries (keeps the map bounded without a dedicated timer).
    for (const [orderId, expiry] of this.botCancelledMultiEntryOrderIdExpiryMap) {
      if (expiry <= nowMs) {
        this.botCancelledMultiEntryOrderIdExpiryMap.delete(orderId);
      }
    }

    for (const orderId of orderIdList) {
      this.botCancelledMultiEntryOrderIdExpiryMap.set(orderId, expiryMs);
    }
  }

  protected isBotCancelledMultiEntry(orderId: string): boolean {
    const expiry = this.botCancelledMultiEntryOrderIdExpiryMap.get(orderId);

    if (expiry === undefined) {
      return false;
    }

    if (expiry <= Date.now()) {
      this.botCancelledMultiEntryOrderIdExpiryMap.delete(orderId);

      return false;
    }

    return true;
  }

  protected async cancelOrderListViaTracker(args: { symbol: string; orderIdList: string[]; contextLabel: string; positionId?: string }): Promise<{ cancelledOrderIdList: string[]; failedOrderIdList: string[] }> {
    const { symbol, orderIdList, contextLabel, positionId } = args;

    const outcome = await this.orderManager.enqueueCancelBatch({
      symbol,
      orderIdList,
      modulePrefix: '[PnlMonitor]',
      contextLabel,
      metadata: positionId ? { positionId } : undefined,
    });

    return {
      cancelledOrderIdList: outcome.cancelledOrderIdList,
      failedOrderIdList: outcome.failedToSendOrderIdList,
    };
  }

  protected async cancelStopLossOrderWithLogging(position: MonitoredPosition, contextLabel: string, _errorLevel: 'warn' | 'error'): Promise<void> {
    if (position.stopLossOrderId === null) {
      return;
    }

    const orderId = position.stopLossOrderId;
    const positionId = position.id;
    const symbol = position.symbol;

    await this.orderManager.enqueueCancel({
      symbol,
      orderId,
      modulePrefix: '[PnlMonitor]',
      contextLabel: `SL ${contextLabel}`,
      metadata: { positionId, direction: position.direction },
      onConfirmed: (info) => {
        if (info.kind === 'filled' || info.kind === 'partial_then_terminal') {
          logger.warn({ positionId, symbol, orderId, kind: info.kind, filledAmount: info.filledAmount, source: info.source, contextLabel }, `[PnlMonitor] ${symbol} SL filled during cancel (contextLabel=${contextLabel}, kind=${info.kind}, source=${info.source}, filledAmount=${info.filledAmount}) — position likely already closed`);
        }
      },
    });
  }

  protected async cancelMultiEntryOrders(symbol: string, orderIdList: string[], positionId?: string): Promise<{ cancelledOrderIdList: string[]; failedOrderIdList: string[] }> {
    this.markBotCancelledMultiEntries(orderIdList);

    return this.cancelOrderListViaTracker({
      symbol,
      orderIdList,
      contextLabel: 'multi-entry cleanup',
      positionId,
    });
  }

  protected async splitMultiEntryByPresence(symbol: string, orderIdList: string[]): Promise<{ presentIdList: string[]; absentIdList: string[] }> {
    const presentIdList: string[] = [];
    const absentIdList: string[] = [];

    for (const orderId of orderIdList) {
      try {
        logger.info({ symbol, orderId }, `[PnlMonitor] ${symbol} getOrder request orderId=${orderId} (multi-order timeout split)`);
        const order = await this.exchangeConnector.futures.getOrder(symbol, orderId);
        const status = order?.status;
        logger.info({ symbol, orderId, orderStatus: status, order }, `[PnlMonitor] ${symbol} getOrder response status=${status ?? 'not_found'} orderId=${orderId} (multi-order timeout split)`);

        const isTerminal = !order || status === 'closed' || status === 'canceled' || status === 'expired';

        if (isTerminal) {
          absentIdList.push(orderId);
        } else {
          presentIdList.push(orderId);
        }
      } catch (error: unknown) {
        logger.warn({ error, symbol, orderId }, `[PnlMonitor] ${symbol} getOrder failed for orderId=${orderId} (multi-order timeout split) — assuming absent`);
        absentIdList.push(orderId);
      }
    }

    return { presentIdList, absentIdList };
  }

  protected normalizeLegacyPosition(position: MonitoredPosition): void {
    const legacy = position as unknown as Record<string, unknown>;

    if (legacy.isHalveAtBreakevenEnabled === undefined && legacy.isInsuranceFilled !== undefined) {
      legacy.isHalveAtBreakevenEnabled = legacy.isInsuranceFilled;
    }

    delete legacy.isInsuranceFilled;
    delete legacy.hasHalvedAtBreakeven;

    if (legacy.primaryAvgVolumeOffsetPercent === undefined && legacy.primaryAverageShiftPercent !== undefined) {
      const legacyValue = legacy.primaryAverageShiftPercent;
      legacy.primaryAvgVolumeOffsetPercent = (legacyValue === null || typeof legacyValue === 'number') ? legacyValue : null;
    }

    delete legacy.primaryAverageShiftPercent;

    applyLegacyDefaults(legacy, POSITION_LEGACY_DEFAULTS as Record<string, unknown>);
  }

  protected findActivePositionByKey(symbol: string, direction: 'long' | 'short'): MonitoredPosition | null {
    for (const position of this.positionById.values()) {
      if (position.symbol === symbol && position.direction === direction) {
        return position;
      }
    }

    return null;
  }

  async closeAndRemovePosition(positionId: string): Promise<boolean> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return false;
    }

    try {
      await this.closePosition(position);
      await this.removePosition(positionId);
      logger.info({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Position closed by circuit breaker`);

      return true;
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to close position via circuit breaker`);

      return false;
    }
  }

  protected async verifyAndRestoreStopLoss(position: MonitoredPosition): Promise<StopLossStatus> {
    if (!position.stopLossOrderId) {
      logger.info(
        { positionId: position.id, symbol: position.symbol, currentStopLossLevel: position.currentStopLossLevel, stopLossLastErrorText: position.stopLossLastErrorText },
        `[PnlMonitor] ${position.symbol} SL verify — stopLossOrderId is null in memory, returning missing without exchange call (currentStopLossLevel=${position.currentStopLossLevel}%)`,
      );

      return 'missing';
    }

    try {
      const order = await this.exchangeConnector.futures.getOrder(position.symbol, position.stopLossOrderId);

      logger.info(
        { positionId: position.id, symbol: position.symbol, orderId: position.stopLossOrderId, orderStatus: order.status, amount: order.amount, filledAmount: order.filledAmount, stopPrice: order.stopPrice, reduceOnly: order.reduceOnly, order },
        `[PnlMonitor] ${position.symbol} SL verify status=${order.status} orderId=${position.stopLossOrderId} amount=${order.amount} filledAmount=${order.filledAmount} stopPrice=${order.stopPrice} reduceOnly=${order.reduceOnly}`,
      );

      if (order.status === 'open' || order.status === 'closed') {
        return 'active';
      }
    } catch (error: unknown) {
      logger.warn({ error, positionId: position.id, symbol: position.symbol, orderId: position.stopLossOrderId }, `[PnlMonitor] ${position.symbol} Failed to verify stop-loss order orderId=${position.stopLossOrderId}`);
    }

    if (this.consecutiveClosedPollTickCountByPositionId.has(position.id)) {
      logger.info(
        { positionId: position.id, symbol: position.symbol, stopLossOrderId: position.stopLossOrderId, currentStopLossLevel: position.currentStopLossLevel },
        `[PnlMonitor] ${position.symbol} SL verify — position is closing externally (consecutiveClosedPollTickCount marker present), skipping recreate`,
      );

      return 'missing';
    }

    logger.warn({ positionId: position.id, symbol: position.symbol, orderId: position.stopLossOrderId, stopLossLevel: position.currentStopLossLevel }, `[PnlMonitor] ${position.symbol} Stop-loss order missing, attempting to recreate at ${position.currentStopLossLevel}%`);

    position.stopLossOrderId = null;
    await this.safeUpdateMonitoredPosition(position.id, { stopLossOrderId: null });

    const isRecreated = await this.updateStopLoss(position, position.currentStopLossLevel);

    if (isRecreated && position.stopLossOrderId) {
      logger.info({ positionId: position.id, symbol: position.symbol, stopLossLevel: position.currentStopLossLevel }, `[PnlMonitor] ${position.symbol} Stop-loss recreated at ${position.currentStopLossLevel}%`);

      return 'recreated';
    }

    return 'missing';
  }

  protected async updateStopLoss(position: MonitoredPosition, stopLossLevel: number): Promise<boolean> {
    if (this.consecutiveClosedPollTickCountByPositionId.has(position.id)) {
      logger.info(
        { positionId: position.id, symbol: position.symbol, stopLossLevel },
        `[PnlMonitor] ${position.symbol} updateStopLoss skipped — position is closing externally (stopLossLevel=${stopLossLevel}%)`,
      );

      return false;
    }

    if (this.isStopLossUpdateInProgressByPositionId.has(position.id)) {
      logger.info({ positionId: position.id, symbol: position.symbol, stopLossLevel }, `[PnlMonitor] ${position.symbol} updateStopLoss skipped — already in progress for this position (stopLossLevel=${stopLossLevel}%)`);

      return false;
    }

    this.isStopLossUpdateInProgressByPositionId.add(position.id);

    try {
      if (stopLossLevel < position.currentStopLossLevel) {
        logger.warn({ positionId: position.id, symbol: position.symbol, stopLossLevel, currentStopLossLevel: position.currentStopLossLevel }, `[PnlMonitor] ${position.symbol} Rejected stop-loss regression ${position.currentStopLossLevel}% → ${stopLossLevel}%`);

        return false;
      }

      if (stopLossLevel === position.currentStopLossLevel && position.stopLossOrderId) {
        logger.info({ positionId: position.id, symbol: position.symbol, stopLossLevel, orderId: position.stopLossOrderId }, `[PnlMonitor] ${position.symbol} Stop-loss already set at ${stopLossLevel}%, skipping recreate`);

        return true;
      }

      const effectiveStopLossLevel = Math.max(stopLossLevel, MIN_STOP_LOSS_LEVEL);
      const stopLossPrice = this.calculateStopLossPrice(position, effectiveStopLossLevel);
      const precisePrice = this.exchangeConnector.futures.priceToPrecision(position.symbol, stopLossPrice);
      const preciseAmount = this.exchangeConnector.futures.amountToPrecision(position.symbol, position.contracts);

      const positionId = position.id;
      const symbol = position.symbol;
      const oldStopLossOrderId = position.stopLossOrderId;

      const { isSuccess, orderId, errorText } = await this.orderManager.enqueueReplaceStopLoss({
        positionId,
        symbol,
        direction: position.direction,
        oldOrderId: oldStopLossOrderId,
        triggerPrice: Number(precisePrice),
        amount: Number(preciseAmount),
        metadata: { stopLossLevel: effectiveStopLossLevel },
        onOldOrderConfirmed: (info) => {
          if (info.kind === 'filled' || info.kind === 'partial_then_terminal') {
            logger.warn({ positionId, symbol, orderId: oldStopLossOrderId, kind: info.kind, filledAmount: info.filledAmount, source: info.source }, `[PnlMonitor] ${symbol} OLD SL filled during replace (kind=${info.kind}, source=${info.source}, filledAmount=${info.filledAmount}) — position likely closed, new SL placement may target a closed position`);
          }
        },
      });

      if (isSuccess && orderId !== null) {
        const wasErrorPersisted = position.stopLossLastErrorText !== null;

        position.stopLossOrderId = orderId;
        position.currentStopLossLevel = stopLossLevel;
        position.stopLossLastErrorText = null;

        await this.safeUpdateMonitoredPosition(position.id, {
          stopLossOrderId: orderId,
          currentStopLossLevel: stopLossLevel,
          ...(wasErrorPersisted ? { stopLossLastErrorText: null } : {}),
        });

        await this.cancelMultiEntryOnStopLoss(position);

        return true;
      }

      const truncatedErrorText = (errorText ?? 'Unknown error').slice(0, STOP_LOSS_ERROR_TEXT_MAX_LENGTH);

      if (position.stopLossLastErrorText !== truncatedErrorText) {
        position.stopLossLastErrorText = truncatedErrorText;
        await this.safeUpdateMonitoredPosition(position.id, { stopLossLastErrorText: truncatedErrorText });
      }

      return false;
    } finally {
      this.isStopLossUpdateInProgressByPositionId.delete(position.id);
    }
  }

  protected async closePosition(position: MonitoredPosition): Promise<void> {
    const preciseAmount = this.exchangeConnector.futures.amountToPrecision(position.symbol, position.contracts);

    await this.orderManager.enqueueClosePositionMarket({
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      amount: Number(preciseAmount),
      contextLabel: `closePosition [${position.timeframe}]`,
    });

    if (position.stopLossOrderId) {
      await this.orderManager.enqueueCancel({
        symbol: position.symbol,
        orderId: position.stopLossOrderId,
        modulePrefix: '[PnlMonitor]',
        contextLabel: 'SL cleanup after closePosition',
        metadata: { positionId: position.id, direction: position.direction },
      });
    }
  }

  protected async drainMultiEntryListAndPersist(position: MonitoredPosition, contextLabel: string): Promise<number> {
    const orderIdList = position.multiEntryOrderIdList;

    if (orderIdList === null || orderIdList.length === 0) {
      return 0;
    }

    await this.cancelMultiEntryOrders(position.symbol, orderIdList, position.id);

    position.multiEntryOrderIdList = null;
    position.lastFillKlineOpenTimestamp = null;
    await this.safeUpdateMonitoredPosition(position.id, {
      multiEntryOrderIdList: null,
      lastFillKlineOpenTimestamp: null,
    });

    logger.info(
      { positionId: position.id, symbol: position.symbol, drainedCount: orderIdList.length, contextLabel },
      `[PnlMonitor] ${position.symbol} Drained ${orderIdList.length} pending multi-entry orders (${contextLabel}) — OrderManager takes over for confirmation`,
    );

    return orderIdList.length;
  }

  protected async cancelMultiEntryOnStopLoss(position: MonitoredPosition): Promise<void> {
    if (position.stopLossOrderId === null) {
      return;
    }

    if (position.multiEntryOrderIdList === null || position.multiEntryOrderIdList.length === 0) {
      return;
    }

    logger.info(
      { positionId: position.id, symbol: position.symbol, orderCount: position.multiEntryOrderIdList.length, stopLossOrderId: position.stopLossOrderId },
      `[PnlMonitor] ${position.symbol} Cancelling ${position.multiEntryOrderIdList.length} unfilled multi-entry orders after stop-loss creation`,
    );

    await this.drainMultiEntryListAndPersist(position, 'after stop-loss creation');
  }

  protected async cancelAllTpOrders(positionId: string): Promise<{ cancelledCount: number; failedCount: number }> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return { cancelledCount: 0, failedCount: 0 };
    }

    const orderIdList = position.tpOrderIdList;

    if (orderIdList === null || orderIdList.length === 0) {
      return { cancelledCount: 0, failedCount: 0 };
    }

    logger.info(
      { positionId, symbol: position.symbol, orderCount: orderIdList.length, timeframe: position.timeframe },
      `[PnlMonitor] ${position.symbol} Cancelling ${orderIdList.length} TP orders (manual cleanup) [${position.timeframe}]`,
    );

    const outcome = await this.cancelOrderListViaTracker({
      symbol: position.symbol,
      orderIdList,
      contextLabel: 'manual TP cleanup',
      positionId,
    });

    position.tpOrderIdList = null;
    await this.safeUpdateMonitoredPosition(positionId, { tpOrderIdList: null });

    return {
      cancelledCount: outcome.cancelledOrderIdList.length,
      failedCount: outcome.failedOrderIdList.length,
    };
  }

  async cancelPendingMultiEntries(positionId: string): Promise<{ cancelledCount: number }> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return { cancelledCount: 0 };
    }

    if (position.multiEntryOrderIdList === null || position.multiEntryOrderIdList.length === 0) {
      return { cancelledCount: 0 };
    }

    logger.info(
      { positionId: position.id, symbol: position.symbol, orderCount: position.multiEntryOrderIdList.length },
      `[PnlMonitor] ${position.symbol} Cancelling ${position.multiEntryOrderIdList.length} pending multi-entry orders (move MA after partial fill)`,
    );

    const cancelledCount = await this.drainMultiEntryListAndPersist(position, 'move MA after partial fill');

    return { cancelledCount };
  }

  // Cancel ONLY the breaker's own breakeven-exit TP order by its exchange id — leaves any other
  // orders on the symbol (e.g. a TP the user placed themselves) untouched. The breaker tracks its
  // single TP id in its runner; this removes just that id from tpOrderIdList instead of draining
  // the whole list. Used on breaker cancel / TP replace so cancelling a breaker never wipes
  // user-managed orders.
  async cancelFibTakeProfitOrder(positionId: string, tpOrderId: string): Promise<boolean> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return false;
    }

    logger.info(
      { positionId, symbol: position.symbol, tpOrderId, timeframe: position.timeframe },
      `[PnlMonitor] ${position.symbol} Cancelling breaker breakeven-exit TP order ${tpOrderId} (targeted) [${position.timeframe}]`,
    );

    await this.cancelOrderListViaTracker({
      symbol: position.symbol,
      orderIdList: [tpOrderId],
      contextLabel: 'fib breakeven TP targeted cancel',
      positionId,
    });

    if (position.tpOrderIdList !== null && position.tpOrderIdList.includes(tpOrderId)) {
      const remainingTpOrderIdList = position.tpOrderIdList.filter((orderId) => orderId !== tpOrderId);

      position.tpOrderIdList = remainingTpOrderIdList.length > 0 ? remainingTpOrderIdList : null;
      await this.safeUpdateMonitoredPosition(positionId, { tpOrderIdList: position.tpOrderIdList });
    }

    return true;
  }

  // Wires the VolumeFibOrderManager so it can drop its setup when a fib-managed position closes
  // (via low-trailing SL fill, breakeven exit, or manual close). Invoked from removePosition.
  // Programmatic import of a freshly-opened fib position into PnL monitoring. The position opts
  // OUT of PnlMonitor's own SL/auto-close (isTrailingSlEnabled=false, isAutoCloseEnabled=false) —
  // the VolumeFibOrderManager owns the low-trailing SL. Core MA Chaser positions are untouched.
  async importFibPosition(args: ImportFibPositionArgs): Promise<string | null> {
    const { symbol, direction, remainingEntryOrderIdList, leverage } = args;

    try {
      logger.info({ symbol, direction }, `[PnlMonitor] ${symbol} readPositionState request (fib import)`);
      const stateResult = await this.exchangeConnector.positionManager.readPositionState({
        symbol,
        marketType: MarketTypeEnum.Futures,
        direction,
      });
      logger.info({ symbol, direction, kind: stateResult.kind }, `[PnlMonitor] ${symbol} readPositionState response kind=${stateResult.kind} (fib import)`);

      if (stateResult.kind !== 'present') {
        logger.warn({ symbol, direction, kind: stateResult.kind }, `[PnlMonitor] ${symbol} Cannot import fib position — state ${stateResult.kind}`);

        return null;
      }

      const existing = this.findActivePositionByKey(symbol, direction);

      if (existing) {
        logger.info({ symbol, direction, positionId: existing.id }, `[PnlMonitor] ${symbol} Fib position already tracked (id=${existing.id})`);

        return existing.id;
      }

      const snap = stateResult.position;
      const hasRemaining = remainingEntryOrderIdList.length > 0;
      const resolvedLeverage = leverage > 0 ? leverage : (snap.leverage > 0 ? snap.leverage : 1);
      const position = this.buildImportedPosition(snap, direction, {
        leverage: resolvedLeverage,
        isTrailingSlEnabled: false,
        isAutoCloseEnabled: false,
        multiEntryOrderIdList: hasRemaining ? remainingEntryOrderIdList : null,
      });

      this.positionById.set(position.id, position);
      await this.positionStore.saveMonitoredPosition(position);

      logger.info(
        { positionId: position.id, symbol, direction, contracts: snap.contracts, entryPrice: snap.entryPrice },
        `[PnlMonitor] ${symbol} Fib position imported (id=${position.id}, contracts=${snap.contracts}, entry=${snap.entryPrice}, trailing/auto-close OFF)`,
      );

      return position.id;
    } catch (error: unknown) {
      logger.error({ error, symbol, direction }, `[PnlMonitor] ${symbol} Failed to import fib position`);

      return null;
    }
  }

  // Places the breakeven exit ladder for a fib position on invalidation: N equal reduce-only
  // close orders laddered from avgEntry × (1 + eps%) upward. N = number of filled entry orders.
  async placeFibBreakevenExit(args: PlaceFibBreakevenExitArgs): Promise<boolean> {
    const { positionId, fibAvgEntry, epsPercent, orderCount } = args;
    const position = this.positionById.get(positionId);

    if (!position) {
      logger.warn({ positionId }, '[PnlMonitor] placeFibBreakevenExit — position not found');

      return false;
    }

    if (position.contracts <= 0) {
      logger.warn({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} placeFibBreakevenExit — no contracts`);

      return false;
    }

    const tradeSymbol = this.exchangeConnector.futures.tradeSymbols.get(position.symbol);
    const tickSizeRaw = tradeSymbol ? Number(tradeSymbol.filter.tickSize) : 0;
    const tickSize = Number.isFinite(tickSizeRaw) && tickSizeRaw > 0 ? tickSizeRaw : 0;

    const ladder = computeBreakevenLadder({
      fibAvgEntry,
      totalContracts: position.contracts,
      orderCount: Math.max(1, orderCount),
      epsPercent,
      tickSize,
      direction: position.direction,
    });

    const priceList = ladder.priceList.map((price) => Number(this.exchangeConnector.futures.priceToPrecision(position.symbol, price)));
    const amountList = ladder.amountList.map((amount) => Number(this.exchangeConnector.futures.amountToPrecision(position.symbol, amount)));

    const result = await this.placeTpSplitOrders({
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      priceList,
      amountList,
    });

    if (!result.isCreated) {
      logger.error(
        { positionId, symbol: position.symbol, errorText: result.errorText },
        `[PnlMonitor] ${position.symbol} placeFibBreakevenExit failed: ${result.errorText ?? 'unknown'}`,
      );

      return false;
    }

    position.tpOrderIdList = result.orderIdList;
    await this.safeUpdateMonitoredPosition(position.id, { tpOrderIdList: result.orderIdList });

    logger.info(
      { positionId, symbol: position.symbol, orderCount: result.orderIdList.length },
      `[PnlMonitor] ${position.symbol} Fib breakeven exit placed — ${result.orderIdList.length} reduce-only orders`,
    );

    return true;
  }

  // Single reduce-only take-profit at an exact price for the FULL position — the breaker engine's
  // breakeven exit (the runner computes the target itself). Registered in tpOrderIdList so the
  // external-close cleanup cancels it like any TP fan. Returns the exchange order id (null on failure).
  async placeFibTakeProfit(args: PlaceFibTakeProfitArgs): Promise<string | null> {
    const { positionId, price } = args;
    const position = this.positionById.get(positionId);

    if (!position) {
      logger.warn({ positionId }, '[PnlMonitor] placeFibTakeProfit — position not found');

      return null;
    }

    if (position.contracts <= 0) {
      logger.warn({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} placeFibTakeProfit — no contracts`);

      return null;
    }

    const priceRounded = Number(this.exchangeConnector.futures.priceToPrecision(position.symbol, price));
    const amountRounded = Number(this.exchangeConnector.futures.amountToPrecision(position.symbol, position.contracts));
    const result = await this.placeTpSplitOrders({
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      priceList: [priceRounded],
      amountList: [amountRounded],
    });

    if (!result.isCreated || result.orderIdList.length === 0) {
      logger.error(
        { positionId, symbol: position.symbol, errorText: result.errorText },
        `[PnlMonitor] ${position.symbol} placeFibTakeProfit failed: ${result.errorText ?? 'unknown'}`,
      );

      return null;
    }

    position.tpOrderIdList = result.orderIdList;
    await this.safeUpdateMonitoredPosition(position.id, { tpOrderIdList: result.orderIdList });

    logger.info(
      { positionId, symbol: position.symbol, price: priceRounded, orderId: result.orderIdList[0] },
      `[PnlMonitor] ${position.symbol} Fib take-profit placed @ ${priceRounded}`,
    );

    return result.orderIdList[0];
  }

  // Force-close a fib position at market (used by the breaker engine on exit timeout): cancel the
  // reduce-only breakeven fan, market-close the full position, and remove it from monitoring.
  async closeFibPositionAtMarket(positionId: string): Promise<boolean> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return false;
    }

    try {
      if (position.tpOrderIdList !== null && position.tpOrderIdList.length > 0) {
        await this.cancelOrderListViaTracker({
          symbol: position.symbol,
          orderIdList: [...position.tpOrderIdList],
          contextLabel: 'fib exit-timeout TP cleanup',
          positionId: position.id,
        });
        position.tpOrderIdList = null;
        await this.safeUpdateMonitoredPosition(position.id, { tpOrderIdList: null });
      }

      await this.closePosition(position);
      await this.removePosition(positionId);
      logger.info({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Fib position closed at market (exit timeout)`);

      return true;
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to close fib position at market (exit timeout)`);

      return false;
    }
  }

  protected async scanExchangePositions(): Promise<void> {
    const nowMs = Date.now();
    const isThrottled = (nowMs - this.lastPositionsScanAtMs) < POSITIONS_SCAN_THROTTLE_MS;

    if (isThrottled || this.isPositionsScanInProgress) {
      return;
    }

    this.isPositionsScanInProgress = true;

    try {
      logger.info('[PnlMonitor] readAllPositions request (positions list scan)');
      const positionList = await this.exchangeConnector.positionManager.readAllPositions({ marketType: MarketTypeEnum.Futures });
      logger.info({ count: positionList.length }, `[PnlMonitor] readAllPositions response count=${positionList.length} (positions list scan)`);

      this.refreshEphemeralCache(positionList);
      this.lastPositionsScanAtMs = nowMs;
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] readAllPositions failed — using prior ephemeral cache');
    } finally {
      this.isPositionsScanInProgress = false;
    }
  }

  protected refreshEphemeralCache(positionList: Position[]): void {
    this.ephemeralPositionByKey.clear();

    const trackedKeySet = new Set<string>();

    for (const position of this.positionById.values()) {
      trackedKeySet.add(`${position.symbol}:${position.direction}`);
    }

    for (const snap of positionList) {
      if (snap.direction === null) {
        continue;
      }

      const key = `${snap.symbol}:${snap.direction}`;

      if (trackedKeySet.has(key)) {
        continue;
      }

      this.ephemeralPositionByKey.set(key, snap);
    }
  }

  protected buildImportedPosition(snap: Position, direction: 'long' | 'short', overrides: Partial<MonitoredPosition> = {}): MonitoredPosition {
    const id = `IMP_${snap.symbol}_${direction}_${Date.now()}`;
    const leverage = snap.leverage > 0 ? snap.leverage : 1;

    return {
      id,
      symbol: snap.symbol,
      timeframe: IMPORTED_POSITION_TIMEFRAME,
      direction,
      maLevel: IMPORTED_POSITION_MA_LEVEL,
      avgPriceOffsetPercent: 0,
      volumeUsdt: 0,
      leverage,
      entryPrice: snap.entryPrice,
      liquidationPrice: snap.liquidationPrice ?? 0,
      contracts: snap.contracts,
      lastAcknowledgedThreshold: 0,
      stopLossOrderId: null,
      currentStopLossLevel: 0,
      stopLossLastErrorText: null,
      insuranceChaserId: null,
      insuranceFailReason: null,
      isInsuranceUnavailableNotified: false,
      isLossAlertAcknowledged: false,
      isUserResponded: false,
      isAutoCloseNotified: false,
      lastAlertMessageId: null,
      tpOrderIdList: null,
      multiEntryOrderIdList: null,
      primaryOrderCount: 1,
      primarySpreadPercent: null,
      primaryAvgVolumeOffsetPercent: null,
      plannedNotionalUsdt: 0,
      lastFillKlineOpenTimestamp: null,
      entryKlineHighSnapshot: null,
      entryKlineLowSnapshot: null,
      halveEnableKlineHighSnapshot: null,
      halveEnableKlineLowSnapshot: null,
      halveEnableKlineOpenTimestamp: null,
      isHalveAtBreakevenEnabled: false,
      hasInsuranceCycleCompleted: true,
      isAugmented: false,
      isTrailingSlEnabled: true,
      isPnlAlertsEnabled: true,
      isAutoCloseEnabled: true,
      isImported: true,
      createdAt: Date.now(),
      ...overrides,
    };
  }

  protected async placeTpSplitOrders(args: TpSplitOrderPlacementArgs): Promise<TpSplitOrderPlacementResult> {
    const { positionId, symbol, direction, priceList, amountList } = args;

    const result = await this.orderManager.enqueueCreateTpSplitFan({
      positionId,
      symbol,
      direction,
      priceList,
      amountList,
    });

    return result;
  }

  protected async onPositionTeardown(_position: MonitoredPosition | null): Promise<void> {}

  protected async onExternalCloseStart(_position: MonitoredPosition): Promise<void> {}

  protected async onExternalCloseInsuranceCleanup(_position: MonitoredPosition): Promise<void> {}

  protected onExternalMultiEntryCancel(_position: MonitoredPosition, _cancelType: string | undefined): void {}

  protected async removePosition(positionId: string): Promise<void> {
    const position = this.positionById.get(positionId);

    await this.onPositionTeardown(position ?? null);

    if (position && position.multiEntryOrderIdList !== null && position.multiEntryOrderIdList.length > 0) {
      await this.cancelMultiEntryOrders(position.symbol, position.multiEntryOrderIdList);
    }

    this.consecutiveClosedPollTickCountByPositionId.delete(positionId);
    this.lastReadStateKindByPositionId.delete(positionId);
    this.positionById.delete(positionId);
    await this.positionStore.removeMonitoredPosition(positionId);

    if (this.onPositionRemoved !== null) {
      try {
        this.onPositionRemoved(positionId);
      } catch (error: unknown) {
        logger.error({ error, positionId }, `[PnlMonitor] onPositionRemoved handler threw for ${positionId}`);
      }
    }
  }

  protected async cleanupExchangeOrdersOnExternalClose(position: MonitoredPosition): Promise<void> {
    this.consecutiveClosedPollTickCountByPositionId.set(position.id, EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT);

    await this.onExternalCloseStart(position);

    await this.cancelStopLossOrderWithLogging(position, 'external close cleanup', 'warn');

    if (position.tpOrderIdList !== null && position.tpOrderIdList.length > 0) {
      await this.cancelOrderListViaTracker({
        symbol: position.symbol,
        orderIdList: position.tpOrderIdList,
        contextLabel: 'TP cleanup (external close)',
        positionId: position.id,
      });
    }

    if (position.multiEntryOrderIdList !== null && position.multiEntryOrderIdList.length > 0) {
      await this.cancelOrderListViaTracker({
        symbol: position.symbol,
        orderIdList: position.multiEntryOrderIdList,
        contextLabel: 'multi-entry cleanup (external close)',
        positionId: position.id,
      });
    }

    await this.onExternalCloseInsuranceCleanup(position);
  }

  async handleOrderUpdate(event: OrderUpdateEvent): Promise<void> {
    try {
      const status = event.status;
      const isTerminal = status === 'closed' || status === 'canceled' || status === 'expired';

      if (!isTerminal) {
        return;
      }

      for (const position of this.positionById.values()) {
        if (position.symbol !== event.symbol) {
          continue;
        }

        const list = position.multiEntryOrderIdList;

        if (!Array.isArray(list) || list.length === 0) {
          continue;
        }

        if (!list.includes(event.orderId)) {
          continue;
        }

        const filtered = list.filter((id) => id !== event.orderId);

        if (filtered.length === 0) {
          position.multiEntryOrderIdList = null;
          position.lastFillKlineOpenTimestamp = null;
          await this.safeUpdateMonitoredPosition(position.id, {
            multiEntryOrderIdList: null,
            lastFillKlineOpenTimestamp: null,
          });
          logger.info(
            { positionId: position.id, symbol: position.symbol, orderId: event.orderId, status, cancelType: event.cancelType, rejectReason: event.rejectReason, timeframe: position.timeframe },
            `[PnlMonitor] ${position.symbol} Last multi-entry orderId ${event.orderId} drained via WS — status=${status}, cancelType=${event.cancelType ?? 'n/a'}, list cleared [${position.timeframe}]`,
          );
        } else {
          position.multiEntryOrderIdList = filtered;
          await this.safeUpdateMonitoredPosition(position.id, {
            multiEntryOrderIdList: filtered,
          });
          logger.info(
            { positionId: position.id, symbol: position.symbol, orderId: event.orderId, status, cancelType: event.cancelType, rejectReason: event.rejectReason, remainingCount: filtered.length, timeframe: position.timeframe },
            `[PnlMonitor] ${position.symbol} Multi-entry orderId ${event.orderId} drained via WS — status=${status}, cancelType=${event.cancelType ?? 'n/a'}, remaining=${filtered.length} [${position.timeframe}]`,
          );
        }

        if (status === 'canceled' && !this.isBotCancelledMultiEntry(event.orderId)) {
          this.onExternalMultiEntryCancel(position, event.cancelType);
        }
      }
    } catch (error: unknown) {
      logger.error({ error, symbol: event.symbol, orderId: event.orderId }, `[PnlMonitor] ${event.symbol} handleOrderUpdate threw unexpectedly`);
    }
  }

  protected async runReactiveCheckers(_position: MonitoredPosition, _source: 'klineUpdatedTick' | 'klineClosed' | 'positionUpdate'): Promise<void> {}

  protected getMultiOrderFillTimeoutKlineCount(_interval: KlineInterval): number | null {
    return null;
  }

  protected async notifyMultiOrderTimeout(_args: MultiOrderTimeoutNotifyArgs): Promise<void> {}

  attachMarketDataManager(interval: KlineInterval, marketDataManager: MarketDataSource): void {
    this.marketDataManagerByInterval.set(interval, marketDataManager);
    this.subscribeToMarketDataManager(interval, marketDataManager);

    logger.info({ interval }, `[PnlMonitor] Attached MarketDataManager [${interval}]`);
  }

  protected subscribeToMarketDataManager(interval: KlineInterval, marketDataManager: MarketDataSource): void {
    if (typeof marketDataManager.on !== 'function') {
      logger.warn({ interval }, `[PnlMonitor] MarketDataManager.on is not a function — skipping klineClosed/klineUpdatedTick subscriptions [${interval}]`);

      return;
    }

    marketDataManager.on('klineClosed', (symbol: string, kline: Kline) => {
      this.lastPriceBySymbol.set(symbol, kline.closePrice);

      this.handleMultiOrderTimeoutOnKlineClosed(interval, symbol, kline).catch((error: unknown) => {
        logger.error({ error, symbol, interval }, `[PnlMonitor] ${symbol} handleMultiOrderTimeoutOnKlineClosed failed [${interval}]`);
      });

      this.runReactiveCheckersForSymbol(interval, symbol, 'klineClosed').catch((error: unknown) => {
        logger.error({ error, symbol, interval }, `[PnlMonitor] ${symbol} runReactiveCheckersForSymbol failed on klineClosed [${interval}]`);
      });
    });

    marketDataManager.on('klineUpdatedTick', (symbol: string, kline: Kline) => {
      this.lastPriceBySymbol.set(symbol, kline.closePrice);

      this.runReactiveCheckersForSymbol(interval, symbol, 'klineUpdatedTick').catch((error: unknown) => {
        logger.error({ error, symbol, interval }, `[PnlMonitor] ${symbol} runReactiveCheckersForSymbol failed on klineUpdatedTick [${interval}]`);
      });
    });
  }

  protected async runReactiveCheckersForSymbol(interval: KlineInterval, symbol: string, source: 'klineUpdatedTick' | 'klineClosed'): Promise<void> {
    for (const position of this.positionById.values()) {
      if (position.symbol !== symbol || position.timeframe !== interval) {
        continue;
      }

      await this.runReactiveCheckers(position, source);
    }
  }

  protected async handleMultiOrderTimeoutOnKlineClosed(interval: KlineInterval, symbol: string, kline: Kline): Promise<void> {
    if (!(ALL_SUPPORTED_INTERVAL_LIST as readonly string[]).includes(interval)) {
      return;
    }

    const timeoutKlineCount = this.getMultiOrderFillTimeoutKlineCount(interval);

    if (timeoutKlineCount === null || !Number.isInteger(timeoutKlineCount) || timeoutKlineCount < 1) {
      return;
    }

    const intervalMs = this.marketDataManagerByInterval.get(interval)?.getIntervalMs();

    if (intervalMs === undefined || intervalMs <= 0) {
      return;
    }

    for (const position of this.positionById.values()) {
      if (position.symbol !== symbol || position.timeframe !== interval) {
        continue;
      }

      if (position.multiEntryOrderIdList === null || position.multiEntryOrderIdList.length === 0) {
        continue;
      }

      if (position.lastFillKlineOpenTimestamp === null) {
        continue;
      }

      const klinesSinceFill = (kline.openTimestamp - position.lastFillKlineOpenTimestamp) / intervalMs;

      if (klinesSinceFill < timeoutKlineCount) {
        continue;
      }

      const orderIdSnapshot = [...position.multiEntryOrderIdList];

      logger.info(
        { positionId: position.id, symbol: position.symbol, klinesSinceFill, timeoutKlineCount, lastFillKlineOpenTimestamp: position.lastFillKlineOpenTimestamp, klineOpenTimestamp: kline.openTimestamp, pendingOrderCount: orderIdSnapshot.length, timeframe: interval },
        `[PnlMonitor] ${position.symbol} Multi-order fill timeout — ${klinesSinceFill} closed klines after first fill (threshold ${timeoutKlineCount}), checking ${orderIdSnapshot.length} pending entries [${interval}]`,
      );

      const { presentIdList, absentIdList } = await this.splitMultiEntryByPresence(symbol, orderIdSnapshot);

      if (presentIdList.length === 0) {
        position.multiEntryOrderIdList = null;
        position.lastFillKlineOpenTimestamp = null;
        await this.safeUpdateMonitoredPosition(position.id, {
          multiEntryOrderIdList: null,
          lastFillKlineOpenTimestamp: null,
        });

        logger.info(
          { positionId: position.id, symbol: position.symbol, absentCount: absentIdList.length, timeframe: interval },
          `[PnlMonitor] ${position.symbol} Multi-order timeout: all ${absentIdList.length} orders already absent (terminal) — silent drain, no Telegram [${interval}]`,
        );

        continue;
      }

      await this.cancelMultiEntryOrders(symbol, presentIdList);

      position.multiEntryOrderIdList = null;
      position.lastFillKlineOpenTimestamp = null;
      await this.safeUpdateMonitoredPosition(position.id, {
        multiEntryOrderIdList: null,
        lastFillKlineOpenTimestamp: null,
      });

      logger.info(
        { positionId: position.id, symbol: position.symbol, cancelledCount: presentIdList.length, absentCount: absentIdList.length, timeframe: interval },
        `[PnlMonitor] ${position.symbol} Multi-order fill timeout drain complete — cancelled ${presentIdList.length}, absent ${absentIdList.length} [${interval}]`,
      );

      await this.notifyMultiOrderTimeout({
        positionId: position.id,
        symbol: position.symbol,
        timeframe: position.timeframe,
        direction: position.direction,
        maLevel: position.maLevel,
        cancelledCount: presentIdList.length,
        absentCount: absentIdList.length,
        timeoutKlineCount,
      });
    }
  }

  protected async onPositionEntryChanged(_position: MonitoredPosition, _previousEntryPrice: number, _previousContracts: number, _event: PositionUpdateEvent): Promise<void> {}

  protected onCloseAwaitingTick(_positionId: string): void {}

  protected async notifyPositionRemovedExternally(_args: PositionRemovedExternallyNotifyArgs): Promise<void> {}

  protected async onPollActivePosition(_position: MonitoredPosition, _lastPrice: number): Promise<void> {}

  async handlePositionUpdate(event: PositionUpdateEvent): Promise<void> {
    try {
      if (event.size === 0 || event.entryPrice <= 0) {
        return;
      }

      const eventSide = typeof event.positionSide === 'string' ? event.positionSide.toLowerCase() : '';
      const hasDirectionFilter = eventSide === 'long' || eventSide === 'short';

      for (const position of this.positionById.values()) {
        if (position.symbol !== event.symbol) {
          continue;
        }

        if (hasDirectionFilter && position.direction !== eventSide) {
          continue;
        }

        const previousEntryPrice = position.entryPrice;
        const previousContracts = position.contracts;
        const isWsUpdateChanged = position.entryPrice !== event.entryPrice || position.contracts !== event.size;

        const wsUpdatePayload = {
          positionId: position.id,
          symbol: position.symbol,
          eventSize: event.size,
          eventEntryPrice: event.entryPrice,
          eventLiquidationPrice: event.liquidationPrice,
          previousContracts,
          previousEntryPrice,
          isHalveAtBreakevenEnabled: position.isHalveAtBreakevenEnabled,
          timeframe: position.timeframe,
        };
        const wsUpdateMessage = `[PnlMonitor] ${position.symbol} WS position update event.size=${event.size} event.entryPrice=${event.entryPrice} position.contracts=${previousContracts} position.entryPrice=${previousEntryPrice} isHalveAtBreakevenEnabled=${position.isHalveAtBreakevenEnabled} [${position.timeframe}]`;

        if (isWsUpdateChanged) {
          logger.info(wsUpdatePayload, wsUpdateMessage);
        } else {
          this.logThrottle.throttled({ logger, level: 'info', key: `wsupd:${position.id}`, windowMs: WS_UPDATE_LOG_THROTTLE_MS, payload: wsUpdatePayload, message: wsUpdateMessage });
        }

        if (position.entryPrice !== event.entryPrice) {
          position.entryPrice = event.entryPrice;
          logger.info({ positionId: position.id, symbol: position.symbol, previousEntryPrice, entryPrice: event.entryPrice, timeframe: position.timeframe }, `[PnlMonitor] ${position.symbol} Position WS update entryPrice=${event.entryPrice} (was ${previousEntryPrice}) [${position.timeframe}]`);

          await this.onPositionEntryChanged(position, previousEntryPrice, previousContracts, event);
        }

        await this.runReactiveCheckers(position, 'positionUpdate');
      }
    } catch (error: unknown) {
      logger.error({ error, symbol: event.symbol }, `[PnlMonitor] ${event.symbol} handlePositionUpdate threw unexpectedly`);
    }
  }

  protected async pollPositions(): Promise<void> {
    for (const [positionId, position] of this.positionById) {
      if (this.isReactiveCheckBusyByPositionId.has(positionId)) {
        continue;
      }

      if (!position.symbol) {
        logger.warn(
          { positionId },
          `[PnlMonitor] Removing zombie monitored position ${positionId} — missing symbol (likely Firestore dot-path write artifact)`,
        );
        this.positionById.delete(positionId);
        this.consecutiveClosedPollTickCountByPositionId.delete(positionId);
        this.lastReadStateKindByPositionId.delete(positionId);
        await this.positionStore.removeMonitoredPosition(positionId);

        continue;
      }

      // Hold the busy mark for the WHOLE per-position poll body, not just the check
      // above: a reactive checker starting mid-poll (kline tick / WS update) would
      // otherwise run checkLossThreshold/checkBreakevenHalfClose in parallel with
      // this pass — a double-insurance / double-halve race. onPollActivePosition
      // calls the checkers directly (not via runReactiveCheckers), so the mark
      // does not starve the poll itself.
      this.isReactiveCheckBusyByPositionId.add(positionId);

      try {
        const stateResult = await this.exchangeConnector.positionManager.readPositionState({
          symbol: position.symbol,
          marketType: MarketTypeEnum.Futures,
          direction: position.direction,
        });

        const previousReadStateKind = this.lastReadStateKindByPositionId.get(positionId);
        if (stateResult.kind !== previousReadStateKind) {
          this.lastReadStateKindByPositionId.set(positionId, stateResult.kind);
          logger.info(
            { positionId, symbol: position.symbol, kind: stateResult.kind, previousKind: previousReadStateKind ?? null, direction: position.direction },
            `[PnlMonitor] ${position.symbol} readPositionState response kind=${stateResult.kind} (pollPositions)`,
          );
        }

        if (stateResult.kind === 'ambiguous') {
          logger.warn(
            { positionId, symbol: position.symbol, ambiguityReason: stateResult.reason, exchangeContracts: stateResult.position.contracts, exchangeSide: stateResult.position.side, positionIdx: stateResult.position.positionIdx ?? null, rawInfo: stateResult.position.info },
            `[PnlMonitor] ${position.symbol} readPositionState returned ambiguous (reason=${stateResult.reason}) — skipping tick (NOT counted as closed)`,
          );
          continue;
        }

        if (stateResult.kind === 'absent' && stateResult.confidence === 'unconfirmed') {
          logger.warn(
            { positionId, symbol: position.symbol, reason: stateResult.reason, errorText: stateResult.errorText ?? null },
            `[PnlMonitor] ${position.symbol} readPositionState returned absent/unconfirmed (reason=${stateResult.reason}) — skipping tick (NOT counted as closed)`,
          );
          continue;
        }

        if (stateResult.kind === 'absent') {
          const ticksConfirmed = (this.consecutiveClosedPollTickCountByPositionId.get(positionId) ?? 0) + 1;
          this.consecutiveClosedPollTickCountByPositionId.set(positionId, ticksConfirmed);

          if (ticksConfirmed < EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT) {
            this.onCloseAwaitingTick(positionId);

            logger.warn(
              { positionId, symbol: position.symbol, ticksConfirmed, threshold: EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT, reason: stateResult.reason, direction: position.direction },
              `[PnlMonitor] ${position.symbol} pollPositions saw closed-on-exchange (${ticksConfirmed}/${EXTERNAL_CLOSE_CONFIRMATION_TICK_COUNT}, reason=${stateResult.reason}) — awaiting confirmation before removing (alarm stopped)`,
            );

            continue;
          }

          const lastPrice = this.getLastPriceFromKline(position.symbol);
          const lastPnlPercent = lastPrice > 0 ? this.calculatePnlPercent(position, lastPrice) : null;

          await this.cleanupExchangeOrdersOnExternalClose(position);

          await this.notifyPositionRemovedExternally({
            symbol: position.symbol,
            timeframe: position.timeframe,
            direction: position.direction,
            maLevel: position.maLevel,
            isAugmented: position.isAugmented,
            lastPnlPercent,
            confirmationTickCount: ticksConfirmed,
            confirmationWindowSeconds: Math.round((ticksConfirmed * PNL_POLL_INTERVAL_MS) / 1000),
          });

          await this.removePosition(positionId);
          logger.info(
            { positionId, symbol: position.symbol, ticksConfirmed, direction: position.direction },
            `[PnlMonitor] ${position.symbol} Position closed externally confirmed after ${ticksConfirmed} consecutive polls — removed (SL/TP cancelled if any)`,
          );

          continue;
        }

        const exchangePosition = stateResult.position;
        this.consecutiveClosedPollTickCountByPositionId.delete(positionId);

        position.contracts = exchangePosition.contracts;
        const lastPrice = this.getLastPriceFromKline(position.symbol);

        if (position.liquidationPrice === 0 && exchangePosition.liquidationPrice > 0) {
          position.liquidationPrice = exchangePosition.liquidationPrice;
          await this.safeUpdateMonitoredPosition(positionId, { liquidationPrice: position.liquidationPrice });
        }

        await this.onPollActivePosition(position, lastPrice);
      } catch (error: unknown) {
        logger.warn({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to poll position`);
      } finally {
        this.isReactiveCheckBusyByPositionId.delete(positionId);
      }
    }
  }

}

export { PositionMonitor, PNL_POLL_INTERVAL_MS, MIN_STOP_LOSS_LEVEL, IMPORTED_POSITION_MA_LEVEL };
