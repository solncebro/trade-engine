import { logger } from './logger';
import { LogThrottle } from './logThrottle';
import type {
  ClosePositionMarketResult,
  ConfirmedCancelInfo,
  CreateLimitOrderArgs,
  CreateLimitOrderResult,
  CreateMultiOrderBatchArgs,
  CreateMultiOrderBatchPart,
  CreateMultiOrderBatchResult,
  CreateTpSplitFanArgs,
  CreateTpSplitFanResult,
  EnqueueCancelArgs,
  EnqueueCancelBatchArgs,
  EnqueueClosePositionMarketArgs,
  ExhaustedCancelInfo,
  ExhaustedReason,
  ImmediateBatchOutcome,
  ImmediateCancelOutcome,
  ImmediateCancelResult,
  MoveLimitOrderArgs,
  MoveLimitOrderResult,
  OrderManagerDiagnostics,
  PendingCancelEntry,
  ReplaceStopLossArgs,
  ReplaceStopLossResult,
} from './OrderManager.types';

import type { ExchangeConnector } from '../services/exchangeConnector';
import { TelegramNotifier } from '../services/telegramNotifier';
import type { OrderUpdateEvent } from '../types/index';
import { MarketTypeEnum, TriggerByEnum } from '../types/index';
import { chunkList } from '../utils/chunk';
import { startIntervalScheduler } from '../utils/intervalScheduler';
import type { IntervalSchedulerHandle } from '../utils/intervalScheduler';
import { loggedCancelBatchOrders, loggedCancelOrder, loggedGetOrder } from '../utils/loggedExchangeCall';
import { isOrderSuccessful } from '../utils/order.utils';
import { sleep } from '../utils/sleep';

const TICK_INTERVAL_MS = 1_000;
const PER_ENTRY_COOLDOWN_MS = 2_000;
const PARALLELISM_LIMIT = 5;
const MAX_ATTEMPTS = 8;
const IMMEDIATE_VERIFY_WAIT_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const ALERT_THRESHOLD_AGE_MS = 10_000;
// When idle (no pending cancels, nothing in flight) the heartbeat is throttled to a
// liveness ping every 5 min instead of every 30 s; busy heartbeats still log each tick.
const IDLE_HEARTBEAT_LOG_THROTTLE_MS = 300_000;
// Bybit V5 batch endpoints (order.create-batch / order.cancel-batch) accept at most 10 orders
// per frame for linear futures — anything beyond is rejected per-item. All batch paths (multi-order
// create, TP split create, cancel) chunk into sub-batches of this size. See rules/order-manager.md.
const EXCHANGE_BATCH_MAX_SIZE = 10;
// Delay between create sub-batches — guards Bybit per-UID write rate-limit (10006). Cancel passes 0
// (latency-critical); the cancel retry-tracker is the safety-net for any rate-limit hiccup.
const BATCH_INTER_SUB_BATCH_DELAY_MS = 1_000;

interface OrderManagerArgs {
  exchangeConnector: ExchangeConnector;
  telegramNotifier: TelegramNotifier;
  // Optional client-order-id prefix. When set, protective stops this manager places carry a unique
  // orderLinkId (Bybit) / newClientOrderId (Binance) starting with it, so the owning app can recognise
  // its OWN resting orders on a SHARED exchange account — e.g. to sweep orphaned protective stops
  // without touching another app's orders. Unset → orders carry no client id (legacy behaviour).
  orderLinkIdPrefix?: string;
}

function isTerminalStatus(status: string | undefined | null): status is 'closed' | 'canceled' | 'expired' {
  return status === 'closed' || status === 'canceled' || status === 'expired';
}

interface LastPlacedStopLoss {
  orderId: string;
  triggerPrice: number;
  amount: number;
}

class OrderManager {
  private readonly exchangeConnector: ExchangeConnector;
  private readonly telegramNotifier: TelegramNotifier;
  private readonly orderLinkIdPrefix: string | undefined;
  private clientOrderIdCounter = 0;
  private readonly pendingByOrderId: Map<string, PendingCancelEntry> = new Map();
  private readonly heartbeatLogThrottle: LogThrottle = new LogThrottle();
  private readonly inFlightOrderIdSet: Set<string> = new Set();
  private readonly serializationByKey: Map<string, Promise<unknown>> = new Map();
  private readonly lastPlacedStopLossByPositionId: Map<string, LastPlacedStopLoss> = new Map();
  private tickSchedulerHandle: IntervalSchedulerHandle | null = null;
  private heartbeatSchedulerHandle: IntervalSchedulerHandle | null = null;
  private lastAlertHash: string | null = null;

  constructor(args: OrderManagerArgs) {
    this.exchangeConnector = args.exchangeConnector;
    this.telegramNotifier = args.telegramNotifier;
    this.orderLinkIdPrefix = args.orderLinkIdPrefix;
  }

  // A unique client order id for a freshly placed order, prefixed with orderLinkIdPrefix so it is
  // attributable to this app on a shared account. Undefined when no prefix is configured — the order
  // then carries no client id (unchanged legacy behaviour). Kept short: Bybit caps orderLinkId at 36.
  private buildClientOrderId(): string | undefined {
    if (this.orderLinkIdPrefix === undefined) {
      return undefined;
    }

    this.clientOrderIdCounter += 1;

    return `${this.orderLinkIdPrefix}${Date.now().toString(36)}${this.clientOrderIdCounter.toString(36)}`;
  }

  start(): void {
    if (this.tickSchedulerHandle !== null) {
      logger.warn('[OrderManager] start called while already running — skipping');

      return;
    }

    this.tickSchedulerHandle = startIntervalScheduler({
      tickHandler: () => this.runTick(),
      intervalMs: TICK_INTERVAL_MS,
      contextLabel: '[OrderManager] tick failed',
    });

    this.heartbeatSchedulerHandle = startIntervalScheduler({
      tickHandler: () => this.runHeartbeat(),
      intervalMs: HEARTBEAT_INTERVAL_MS,
      contextLabel: '[OrderManager] heartbeat failed',
    });

    logger.info({ tickIntervalMs: TICK_INTERVAL_MS, cooldownMs: PER_ENTRY_COOLDOWN_MS, parallelismLimit: PARALLELISM_LIMIT, maxAttempts: MAX_ATTEMPTS }, '[OrderManager] started');
  }

  async shutdown(): Promise<void> {
    if (this.tickSchedulerHandle !== null) {
      this.tickSchedulerHandle.stop();
      this.tickSchedulerHandle = null;
    }

    if (this.heartbeatSchedulerHandle !== null) {
      this.heartbeatSchedulerHandle.stop();
      this.heartbeatSchedulerHandle = null;
    }

    const pendingSnapshot = Array.from(this.pendingByOrderId.values());

    if (pendingSnapshot.length === 0) {
      logger.info('[OrderManager] shutdown — no pending cancels');

      return;
    }

    logger.warn({ pendingCount: pendingSnapshot.length, orderIdList: pendingSnapshot.map((entry) => entry.orderId) }, `[OrderManager] shutdown — exhausting ${pendingSnapshot.length} pending cancels with reason=shutdown`);

    for (const entry of pendingSnapshot) {
      await this.exhaustEntry(entry, 'shutdown');
    }

    const orderIdLine = pendingSnapshot.map((entry) => `${entry.symbol} ${entry.orderId} (${entry.contextLabel})`).join('\n');

    this.telegramNotifier.sendMessage(`⚠️ OrderManager shutdown — ${pendingSnapshot.length} pending cancels lost. Manual review on exchange:\n${orderIdLine}`).catch((error: unknown) => {
      logger.error({ error }, '[OrderManager] Failed to send shutdown alert to Telegram');
    });
  }

  async enqueueCancel(args: EnqueueCancelArgs): Promise<ImmediateCancelOutcome> {
    const { symbol, orderId, modulePrefix, contextLabel, metadata = {}, onConfirmed, onExhausted } = args;

    const existing = this.pendingByOrderId.get(orderId);

    if (existing !== undefined) {
      if (onConfirmed !== undefined) {
        existing.onConfirmedList.push(onConfirmed);
      }

      if (onExhausted !== undefined) {
        existing.onExhaustedList.push(onExhausted);
      }

      logger.warn({ symbol, orderId, contextLabel, attemptCount: existing.attemptCount }, `[OrderManager] ${symbol} enqueueCancel merged into existing pending entry (contextLabel=${contextLabel}, orderId=${orderId})`);

      return { immediateResult: 'pending', isStillTracked: true };
    }

    const nowMs = Date.now();
    const entry: PendingCancelEntry = {
      symbol,
      orderId,
      modulePrefix,
      contextLabel,
      metadata,
      attemptCount: 0,
      firstAttemptAtMs: nowMs,
      lastAttemptAtMs: nowMs,
      cooldownUntilMs: nowMs + PER_ENTRY_COOLDOWN_MS,
      lastErrorMessage: null,
      onConfirmedList: onConfirmed !== undefined ? [onConfirmed] : [],
      onExhaustedList: onExhausted !== undefined ? [onExhausted] : [],
    };

    this.pendingByOrderId.set(orderId, entry);

    logger.info({ symbol, orderId, modulePrefix, contextLabel, ...metadata }, `[OrderManager] ${symbol} enqueueCancel start (modulePrefix=${modulePrefix}, contextLabel=${contextLabel}, orderId=${orderId})`);

    const cancelResult = await loggedCancelOrder({
      exchangeConnector: this.exchangeConnector,
      symbol,
      orderId,
      modulePrefix: '[OrderManager]',
      contextLabel: `enqueue-first ${contextLabel}`,
      errorLevel: 'warn',
      metadata,
    });

    entry.attemptCount = 1;
    entry.lastAttemptAtMs = Date.now();

    if (!cancelResult.isSuccess) {
      entry.lastErrorMessage = this.formatErrorMessage(cancelResult.error);
    }

    return await this.waitForImmediateVerify(entry, cancelResult.isSuccess);
  }

  async enqueueCancelBatch(args: EnqueueCancelBatchArgs): Promise<ImmediateBatchOutcome> {
    const { symbol, orderIdList, modulePrefix, contextLabel, metadata = {}, onConfirmed, onExhausted } = args;

    if (orderIdList.length === 0) {
      return { cancelledOrderIdList: [], pendingOrderIdList: [], failedToSendOrderIdList: [] };
    }

    logger.info({ symbol, orderIdList, modulePrefix, contextLabel, count: orderIdList.length, ...metadata }, `[OrderManager] ${symbol} cleanup batch start (count=${orderIdList.length}, contextLabel=${contextLabel})`);

    const outcome: ImmediateBatchOutcome = {
      cancelledOrderIdList: [],
      pendingOrderIdList: [],
      failedToSendOrderIdList: [],
    };

    const nowMs = Date.now();

    for (const orderId of orderIdList) {
      if (this.pendingByOrderId.has(orderId)) {
        const existing = this.pendingByOrderId.get(orderId)!;

        if (onConfirmed !== undefined) {
          existing.onConfirmedList.push(onConfirmed);
        }

        if (onExhausted !== undefined) {
          existing.onExhaustedList.push(onExhausted);
        }

        outcome.pendingOrderIdList.push(orderId);

        continue;
      }

      const entry: PendingCancelEntry = {
        symbol,
        orderId,
        modulePrefix,
        contextLabel,
        metadata,
        attemptCount: 1,
        firstAttemptAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        cooldownUntilMs: nowMs + PER_ENTRY_COOLDOWN_MS,
        lastErrorMessage: null,
        onConfirmedList: onConfirmed !== undefined ? [onConfirmed] : [],
        onExhaustedList: onExhausted !== undefined ? [onExhausted] : [],
      };

      this.pendingByOrderId.set(orderId, entry);
      outcome.pendingOrderIdList.push(orderId);
    }

    // Bybit caps each cancel-batch frame at EXCHANGE_BATCH_MAX_SIZE orders; chunk the send so all
    // orders are cancelled in the immediate pass instead of leaning on the per-order retry tracker
    // for the overflow. Sub-batches go sequentially with no delay (cancel is latency-critical); the
    // retry tracker remains the safety-net for any rate-limit hiccup on a later sub-batch.
    const failedBatchOrderIdSet = new Set<string>();
    const notSentOrderIdSet = new Set<string>();
    let firstBatchError: unknown = null;

    for (const orderIdChunk of chunkList(orderIdList, EXCHANGE_BATCH_MAX_SIZE)) {
      const batchResult = await loggedCancelBatchOrders({
        exchangeConnector: this.exchangeConnector,
        symbol,
        orderIdList: orderIdChunk,
        modulePrefix: '[OrderManager]',
        contextLabel: `enqueue-batch ${contextLabel}`,
        errorLevel: 'warn',
        metadata,
      });

      if (batchResult.error !== null) {
        if (firstBatchError === null) {
          firstBatchError = batchResult.error;
        }

        for (const orderId of orderIdChunk) {
          notSentOrderIdSet.add(orderId);
        }
      } else {
        for (const orderId of batchResult.failedOrderIdList) {
          failedBatchOrderIdSet.add(orderId);
        }
      }
    }

    if (notSentOrderIdSet.size > 0) {
      const errorMessage = this.formatErrorMessage(firstBatchError);

      for (const orderId of notSentOrderIdSet) {
        const entry = this.pendingByOrderId.get(orderId);

        if (entry !== undefined) {
          entry.attemptCount = 0;
          entry.lastErrorMessage = errorMessage;
        }
      }
    }

    for (const orderId of failedBatchOrderIdSet) {
      const entry = this.pendingByOrderId.get(orderId);

      if (entry !== undefined) {
        entry.lastErrorMessage = 'batch-item rejected';
      }
    }

    // Immediate verify (WS-окно + один REST getOrder) выполняется параллельно для всего батча.
    // Caller получает результат после `IMMEDIATE_VERIFY_WAIT_MS`, как для single.
    await sleep(IMMEDIATE_VERIFY_WAIT_MS);

    for (const orderId of orderIdList) {
      const entry = this.pendingByOrderId.get(orderId);

      if (entry === undefined) {
        outcome.cancelledOrderIdList.push(orderId);
        outcome.pendingOrderIdList = outcome.pendingOrderIdList.filter((id) => id !== orderId);

        continue;
      }

      const verifyResult = await loggedGetOrder({
        exchangeConnector: this.exchangeConnector,
        symbol,
        orderId,
        modulePrefix: '[OrderManager]',
        contextLabel: `batch-immediate-verify ${contextLabel}`,
        errorLevel: 'warn',
        metadata,
      });

      if (verifyResult.order !== null && isTerminalStatus(verifyResult.order.status)) {
        const info = this.buildConfirmedInfoFromOrder(entry, verifyResult.order, 'rest');

        await this.confirmEntry(entry, info);
        outcome.cancelledOrderIdList.push(orderId);
        outcome.pendingOrderIdList = outcome.pendingOrderIdList.filter((id) => id !== orderId);

        continue;
      }

      if (notSentOrderIdSet.has(orderId) && entry.attemptCount === 0) {
        outcome.failedToSendOrderIdList.push(orderId);
        outcome.pendingOrderIdList = outcome.pendingOrderIdList.filter((id) => id !== orderId);
      }
    }

    return outcome;
  }

  async enqueueReplaceStopLoss(args: ReplaceStopLossArgs): Promise<ReplaceStopLossResult> {
    const { positionId, symbol, direction, oldOrderId, triggerPrice, amount, metadata = {}, onOldOrderConfirmed } = args;
    const serializationKey = `position:${positionId}`;

    return this.runSerializedByKey(serializationKey, async () => {
      logger.info(
        { positionId, symbol, direction, oldOrderId, triggerPrice, amount, ...metadata },
        `[OrderManager] ${symbol} enqueueReplaceStopLoss start (positionId=${positionId}, oldOrderId=${oldOrderId ?? 'none'}, triggerPrice=${triggerPrice}, amount=${amount})`,
      );

      const previousSnapshot = this.lastPlacedStopLossByPositionId.get(positionId);

      if (
        oldOrderId !== null
        && previousSnapshot !== undefined
        && previousSnapshot.triggerPrice === triggerPrice
        && previousSnapshot.amount === amount
      ) {
        logger.info(
          { positionId, symbol, snapshotOrderId: previousSnapshot.orderId, callerOldOrderId: oldOrderId, triggerPrice, amount, ...metadata },
          `[OrderManager] ${symbol} enqueueReplaceStopLoss idempotent skip — SL already set at triggerPrice=${triggerPrice} amount=${amount} (snapshot orderId=${previousSnapshot.orderId}, caller oldOrderId=${oldOrderId})`,
        );

        return { isSuccess: true, orderId: previousSnapshot.orderId, errorText: null };
      }

      logger.info(
        { positionId, symbol, direction, triggerPrice, amount, ...metadata },
        `[OrderManager] ${symbol} placeStopLoss request direction=${direction} triggerPrice=${triggerPrice} amount=${amount}`,
      );

      let errorText: string | null = null;
      let orderId: string | null = null;

      // Place the NEW stop FIRST and cancel the old one only AFTER the new is confirmed. A rejected
      // placement (e.g. the trigger has already been passed by the market) therefore NEVER leaves the
      // position without a stop — whatever was already resting stays put. The two reduce-only stops
      // co-exist only for the brief place→cancel window; reduce-only prevents the now-redundant one from
      // over-closing if both ever triggered at once.
      try {
        const result = await this.exchangeConnector.positionManager.placeStopLoss({
          symbol,
          marketType: MarketTypeEnum.Futures,
          direction,
          triggerPrice,
          amount,
          triggerBy: TriggerByEnum.LastPrice,
          orderType: 'Market',
          clientOrderId: this.buildClientOrderId(),
        });

        if (isOrderSuccessful(result) && result.orderId) {
          orderId = result.orderId;
          logger.info(
            { positionId, symbol, orderId, result, ...metadata },
            `[OrderManager] ${symbol} placeStopLoss response orderId=${orderId}`,
          );
        } else {
          errorText = result.errorText ?? 'Unknown error';
          logger.error(
            { positionId, symbol, errorText, result, ...metadata },
            `[OrderManager] ${symbol} placeStopLoss response failed: ${errorText}`,
          );
        }
      } catch (error: unknown) {
        errorText = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, positionId, symbol, errorText, ...metadata },
          `[OrderManager] ${symbol} placeStopLoss threw: ${errorText}`,
        );
      }

      if (orderId === null) {
        // New stop rejected → leave the existing stop in place (do NOT cancel it). The position stays
        // protected by whatever was already resting; the caller learns of the rejection and decides.
        logger.warn(
          { positionId, symbol, oldOrderId, errorText, ...metadata },
          `[OrderManager] ${symbol} new stop-loss placement failed — keeping the existing stop (oldOrderId=${oldOrderId ?? 'none'}) to avoid an unprotected window`,
        );

        return { isSuccess: false, orderId: null, errorText };
      }

      this.lastPlacedStopLossByPositionId.set(positionId, { orderId, triggerPrice, amount });

      if (oldOrderId !== null) {
        // The snapshot already points at the NEW order (set above), so the old one only needs cancelling.
        await this.enqueueCancel({
          symbol,
          orderId: oldOrderId,
          modulePrefix: '[OrderManager]',
          contextLabel: 'SL replace after new SL',
          metadata: { positionId, ...metadata },
          onConfirmed: onOldOrderConfirmed,
        });
      }

      return { isSuccess: true, orderId, errorText: null };
    });
  }

  async enqueueClosePositionMarket(args: EnqueueClosePositionMarketArgs): Promise<ClosePositionMarketResult> {
    const { positionId, symbol, direction, amount, contextLabel, metadata = {} } = args;
    const serializationKey = `position:${positionId}`;

    return this.runSerializedByKey(serializationKey, async () => {
      logger.info(
        { positionId, symbol, direction, amount, contextLabel, ...metadata },
        `[OrderManager] ${symbol} closePositionMarket request direction=${direction} amount=${amount} (${contextLabel})`,
      );

      let orderId: string | null = null;
      let errorText: string | null = null;

      try {
        const result = await this.exchangeConnector.positionManager.closePositionMarket({
          symbol,
          marketType: MarketTypeEnum.Futures,
          direction,
          amount,
        });

        if (isOrderSuccessful(result) && result.orderId) {
          orderId = result.orderId;
          logger.info(
            { positionId, symbol, orderId, amount, result, contextLabel, ...metadata },
            `[OrderManager] ${symbol} closePositionMarket response orderId=${orderId} amount=${amount} (${contextLabel})`,
          );
        } else {
          errorText = result.errorText ?? 'Unknown error';
          logger.error(
            { positionId, symbol, errorText, result, contextLabel, ...metadata },
            `[OrderManager] ${symbol} closePositionMarket response failed: ${errorText} (${contextLabel})`,
          );
        }
      } catch (error: unknown) {
        errorText = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, positionId, symbol, errorText, contextLabel, ...metadata },
          `[OrderManager] ${symbol} closePositionMarket threw: ${errorText} (${contextLabel})`,
        );
      }

      return { isSuccess: orderId !== null, orderId, errorText };
    });
  }

  async enqueueCreateTpSplitFan(args: CreateTpSplitFanArgs): Promise<CreateTpSplitFanResult> {
    const { positionId, symbol, direction, priceList, amountList, metadata = {} } = args;
    const serializationKey = `position:${positionId}`;
    const partCount = priceList.length;

    return this.runSerializedByKey(serializationKey, async () => {
      const t0 = Date.now();
      logger.info(
        { positionId, symbol, direction, partCount, ...metadata },
        `[OrderManager] ${symbol} enqueueCreateTpSplitFan start (positionId=${positionId}, parts=${partCount})`,
      );

      if (partCount === 0) {
        return { isCreated: true, orderIdList: [], errorText: null };
      }

      // TP-fan priceList is already nearest-to-market first for BOTH directions:
      // `buildPriceList` starts from price1 (the user's first/nearest TP) and walks away from it
      // (LONG ascending, SHORT descending). So priceList[0] is always the closest order and the
      // natural index order IS the closest-first transmission order. Unlike the entry fan
      // (`enqueueCreateMultiOrderBatch`), this must NOT reverse for long — there the closest sits
      // at priceList[last]; here it sits at priceList[0].
      const orderedIndexList = priceList.map((_, index) => index);

      const transmissionItemList = orderedIndexList.map((canonicalIndex) => ({
        direction,
        amount: amountList[canonicalIndex],
        price: priceList[canonicalIndex],
      }));

      type ClosePositionBatchItemResult = Awaited<ReturnType<typeof this.exchangeConnector.positionManager.closePositionBatchLimit>>[number];

      const t1 = Date.now();

      const { canonicalResultList, successCount, failureCount, transmissionFailureError } = await this.transmitBatchInSubBatches<typeof transmissionItemList[number], ClosePositionBatchItemResult>({
        symbol,
        transmissionItemList,
        orderedIndexList,
        partCount,
        subBatchLogLabel: 'enqueueCreateTpSplitFan',
        contextLabel: 'TP split',
        metadata: { positionId, ...metadata },
        interSubBatchDelayMs: BATCH_INTER_SUB_BATCH_DELAY_MS,
        sendSubBatch: (subBatchItemList) => this.exchangeConnector.positionManager.closePositionBatchLimit({
          symbol,
          marketType: MarketTypeEnum.Futures,
          itemList: subBatchItemList,
        }),
      });

      const t2 = Date.now();

      logger.info(
        { positionId, symbol, partCount, successCount, failureCount, preMs: t1 - t0, exchangeMs: t2 - t1, elapsedMs: t2 - t0, ...metadata },
        `[OrderManager] ${symbol} enqueueCreateTpSplitFan response success=${successCount} failure=${failureCount} elapsedMs=${t2 - t0} (preMs=${t1 - t0}, exchangeMs=${t2 - t1})`,
      );

      const hasFailure = canonicalResultList.some((item) => item === undefined || !item.isSuccess);

      if (hasFailure) {
        // All-or-nothing: roll back every order that DID get placed across the sub-batches.
        const successfulOrderIdList = canonicalResultList
          .filter((item): item is { isSuccess: true; orderId: string; errorText: null } => item !== undefined && item.isSuccess && item.orderId !== null)
          .map((item) => item.orderId);

        if (successfulOrderIdList.length > 0) {
          logger.warn(
            { positionId, symbol, partCount, placedCount: successfulOrderIdList.length, orderIdList: successfulOrderIdList, ...metadata },
            `[OrderManager] ${symbol} TP split partial failure — rolling back ${successfulOrderIdList.length} placed orders`,
          );

          await this.rollbackTpSplitFan(symbol, successfulOrderIdList, positionId, metadata);
        }

        const firstDefinedFailureErrorText = canonicalResultList.find((item) => item !== undefined && !item.isSuccess)?.errorText ?? null;

        return { isCreated: false, orderIdList: [], errorText: firstDefinedFailureErrorText ?? transmissionFailureError ?? 'Unknown error' };
      }

      const orderIdList = canonicalResultList.map((item) => (item as ClosePositionBatchItemResult).orderId as string);

      return { isCreated: true, orderIdList, errorText: null };
    });
  }

  private async rollbackTpSplitFan(symbol: string, orderIdList: string[], positionId: string, metadata: Record<string, unknown>): Promise<void> {
    if (orderIdList.length === 0) {
      return;
    }

    await this.enqueueCancelBatch({
      symbol,
      orderIdList,
      modulePrefix: '[OrderManager]',
      contextLabel: 'TP split rollback',
      metadata: { positionId, ...metadata },
    });
  }

  async enqueueCreateLimitOrder(args: CreateLimitOrderArgs): Promise<CreateLimitOrderResult> {
    const { symbol, direction, amount, price, contextLabel, metadata = {} } = args;

    logger.info(
      { symbol, direction, amount, price, contextLabel, ...metadata },
      `[OrderManager] ${symbol} openPositionLimit request direction=${direction} amount=${amount} price=${price} (${contextLabel})`,
    );

    let orderId: string | null = null;
    let errorText: string | null = null;

    try {
      const result = await this.exchangeConnector.positionManager.openPositionLimit({
        symbol,
        marketType: MarketTypeEnum.Futures,
        direction,
        amount,
        price,
      });

      if (isOrderSuccessful(result) && result.orderId) {
        orderId = result.orderId;
        logger.info(
          { symbol, orderId, amount, price, result, contextLabel, ...metadata },
          `[OrderManager] ${symbol} openPositionLimit response orderId=${orderId} amount=${amount} price=${price} (${contextLabel})`,
        );
      } else {
        errorText = result.errorText ?? 'Unknown error';
        logger.error(
          { symbol, errorText, result, contextLabel, ...metadata },
          `[OrderManager] ${symbol} openPositionLimit response failed: ${errorText} (${contextLabel})`,
        );
      }
    } catch (error: unknown) {
      errorText = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, symbol, errorText, contextLabel, ...metadata },
        `[OrderManager] ${symbol} openPositionLimit threw: ${errorText} (${contextLabel})`,
      );
    }

    return { isSuccess: orderId !== null, orderId, errorText };
  }

  async enqueueMoveLimitOrder(args: MoveLimitOrderArgs): Promise<MoveLimitOrderResult> {
    const { symbol, direction, oldOrderId, amount, newPrice, contextLabel, metadata = {}, onOldOrderConfirmed } = args;

    logger.info(
      { symbol, direction, oldOrderId, amount, newPrice, contextLabel, ...metadata },
      `[OrderManager] ${symbol} enqueueMoveLimitOrder start (oldOrderId=${oldOrderId}, newPrice=${newPrice}, amount=${amount}) — ${contextLabel}`,
    );

    const oldCancelOutcome = await this.enqueueCancel({
      symbol,
      orderId: oldOrderId,
      modulePrefix: '[OrderManager]',
      contextLabel: `move limit order — cancel old (${contextLabel})`,
      metadata: { newPrice, amount, ...metadata },
      onConfirmed: onOldOrderConfirmed,
    });

    if (oldCancelOutcome.immediateResult === 'filled') {
      return { isSuccess: false, orderId: null, errorText: 'old order filled during move', oldCancelOutcome };
    }

    const placeResult = await this.enqueueCreateLimitOrder({
      symbol,
      direction,
      amount,
      price: newPrice,
      contextLabel: `move limit order — place new (${contextLabel})`,
      metadata,
    });

    return { isSuccess: placeResult.isSuccess, orderId: placeResult.orderId, errorText: placeResult.errorText, oldCancelOutcome };
  }

  /**
   * Shared sub-batch transmission for create-batch paths (multi-order entry + TP split).
   * Chunks `transmissionItemList` into sub-batches of `EXCHANGE_BATCH_MAX_SIZE` (Bybit per-frame cap),
   * sends each via `sendSubBatch`, aggregates results, and maps them back to canonical order via
   * `orderedIndexList`. On a sub-batch throw it stops (`break`) — remaining canonical slots stay
   * `undefined`. The caller owns the post-transmission policy (multi keeps partial; TP rolls back).
   */
  private async transmitBatchInSubBatches<TItem, TResult extends { isSuccess: boolean; orderId: string | null; errorText: string | null }>(
    args: {
      symbol: string;
      transmissionItemList: TItem[];
      orderedIndexList: number[];
      partCount: number;
      subBatchLogLabel: string;
      contextLabel: string;
      metadata: Record<string, unknown>;
      interSubBatchDelayMs: number;
      sendSubBatch: (subBatchItemList: TItem[], isFirstSubBatch: boolean) => Promise<TResult[]>;
    },
  ): Promise<{
    canonicalResultList: (TResult | undefined)[];
    successCount: number;
    failureCount: number;
    subBatchCount: number;
    transmissionFailureError: string | null;
  }> {
    const { symbol, transmissionItemList, orderedIndexList, partCount, subBatchLogLabel, contextLabel, metadata, interSubBatchDelayMs, sendSubBatch } = args;

    const subBatchList = chunkList(transmissionItemList, EXCHANGE_BATCH_MAX_SIZE);
    const subBatchCount = subBatchList.length;
    const aggregatedTransmissionResultList: TResult[] = [];
    let transmissionFailureError: string | null = null;

    for (let subBatchIndex = 0; subBatchIndex < subBatchCount; subBatchIndex += 1) {
      const subBatchItemList = subBatchList[subBatchIndex];
      const isFirstSubBatch = subBatchIndex === 0;

      if (!isFirstSubBatch && interSubBatchDelayMs > 0) {
        await sleep(interSubBatchDelayMs);
      }

      logger.info(
        { symbol, subBatchIndex: subBatchIndex + 1, subBatchCount, subBatchSize: subBatchItemList.length, contextLabel, ...metadata },
        `[OrderManager] ${symbol} ${subBatchLogLabel} sub-batch [${subBatchIndex + 1}/${subBatchCount}] (parts=${subBatchItemList.length}) — ${contextLabel}`,
      );

      try {
        const subResult = await sendSubBatch(subBatchItemList, isFirstSubBatch);
        aggregatedTransmissionResultList.push(...subResult);
      } catch (error: unknown) {
        const errorText = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, symbol, subBatchIndex: subBatchIndex + 1, subBatchCount, contextLabel, ...metadata },
          `[OrderManager] ${symbol} ${subBatchLogLabel} sub-batch [${subBatchIndex + 1}/${subBatchCount}] threw — ${errorText} (${contextLabel})`,
        );
        transmissionFailureError = errorText;
        break;
      }
    }

    const successCount = aggregatedTransmissionResultList.filter((item) => item.isSuccess).length;
    const failureCount = aggregatedTransmissionResultList.length - successCount;

    const canonicalResultList: (TResult | undefined)[] = new Array(partCount);
    aggregatedTransmissionResultList.forEach((item, transmissionIndex) => {
      const canonicalIndex = orderedIndexList[transmissionIndex];
      canonicalResultList[canonicalIndex] = item;
    });

    return { canonicalResultList, successCount, failureCount, subBatchCount, transmissionFailureError };
  }

  async enqueueCreateMultiOrderBatch(args: CreateMultiOrderBatchArgs): Promise<CreateMultiOrderBatchResult> {
    const { symbol, direction, partList, leverage, marginMode, contextLabel, metadata = {} } = args;
    const partCount = partList.length;
    const t0 = Date.now();

    logger.info(
      { symbol, direction, partCount, contextLabel, ...metadata },
      `[OrderManager] ${symbol} enqueueCreateMultiOrderBatch start (parts=${partCount}) — ${contextLabel}`,
    );

    if (partCount === 0) {
      return { isCreated: true, orderIdList: [], errorText: null, isPartial: false, placedCount: 0, requestedCount: 0, failedPartList: [], placedOrderIdByCanonicalIndex: [] };
    }

    const orderedIndexList = direction === 'long'
      ? partList.map((_, index) => index).reverse()
      : partList.map((_, index) => index);

    const transmissionItemList = orderedIndexList.map((canonicalIndex) => ({
      direction,
      amount: partList[canonicalIndex].amount,
      price: partList[canonicalIndex].price,
    }));

    logger.info(
      {
        symbol,
        partCount,
        partList: partList.map((part, index) => ({ index, price: part.price, amount: part.amount })),
        contextLabel,
        ...metadata,
      },
      `[OrderManager] ${symbol} batch payload (parts=${partCount}) — ${contextLabel}`,
    );

    type OpenPositionBatchItemResult = Awaited<ReturnType<typeof this.exchangeConnector.positionManager.openPositionBatchLimit>>[number];

    const t1 = Date.now();

    const { canonicalResultList, successCount, failureCount, subBatchCount, transmissionFailureError } = await this.transmitBatchInSubBatches<typeof transmissionItemList[number], OpenPositionBatchItemResult>({
      symbol,
      transmissionItemList,
      orderedIndexList,
      partCount,
      subBatchLogLabel: 'enqueueCreateMultiOrderBatch',
      contextLabel,
      metadata,
      interSubBatchDelayMs: BATCH_INTER_SUB_BATCH_DELAY_MS,
      sendSubBatch: (subBatchItemList, isFirstSubBatch) => this.exchangeConnector.positionManager.openPositionBatchLimit({
        symbol,
        marketType: MarketTypeEnum.Futures,
        itemList: subBatchItemList,
        leverage: isFirstSubBatch ? leverage : undefined,
        marginMode: isFirstSubBatch ? marginMode : undefined,
      }),
    });

    const t2 = Date.now();

    const placedOrderIdByCanonicalIndex: (string | null)[] = canonicalResultList.map((item) => (item !== undefined && item.isSuccess && item.orderId !== null ? item.orderId : null));

    if (successCount + failureCount === 0 && transmissionFailureError !== null) {
      return { isCreated: false, orderIdList: [], errorText: transmissionFailureError, isPartial: false, placedCount: 0, requestedCount: partCount, failedPartList: [...partList], placedOrderIdByCanonicalIndex };
    }

    logger.info(
      { symbol, partCount, successCount, failureCount, subBatchCount, preMs: t1 - t0, exchangeMs: t2 - t1, elapsedMs: t2 - t0, contextLabel, ...metadata },
      `[OrderManager] ${symbol} enqueueCreateMultiOrderBatch response success=${successCount} failure=${failureCount} elapsedMs=${t2 - t0} (preMs=${t1 - t0}, exchangeMs=${t2 - t1}) — ${contextLabel}`,
    );

    const hasFailure = canonicalResultList.some((item) => item === undefined || !item.isSuccess);

    if (hasFailure) {
      const failedIndexList: number[] = [];
      const failedPartList: CreateMultiOrderBatchPart[] = [];
      const failedErrorTextList: string[] = [];
      let firstFailureErrorText: string | null = null;

      canonicalResultList.forEach((item, canonicalIndex) => {
        if (item === undefined) {
          failedIndexList.push(canonicalIndex);
          failedPartList.push({ price: partList[canonicalIndex].price, amount: partList[canonicalIndex].amount });
          const unsentErrorText = transmissionFailureError ?? 'Sub-batch not sent';
          failedErrorTextList.push(`[${canonicalIndex}] ${unsentErrorText}`);
          if (firstFailureErrorText === null) {
            firstFailureErrorText = unsentErrorText;
          }
          return;
        }
        if (!item.isSuccess) {
          failedIndexList.push(canonicalIndex);
          failedPartList.push({ price: partList[canonicalIndex].price, amount: partList[canonicalIndex].amount });
          if (item.errorText !== null && item.errorText !== undefined) {
            failedErrorTextList.push(`[${canonicalIndex}] ${item.errorText}`);
            if (firstFailureErrorText === null) {
              firstFailureErrorText = item.errorText;
            }
          }
        }
      });

      logger.warn(
        { symbol, partCount, successCount, failureCount: failedIndexList.length, failedIndexList, failedErrorTextList, subBatchCount, contextLabel, ...metadata },
        `[OrderManager] ${symbol} multi-order batch partial failure — failed indexes=[${failedIndexList.join(',')}] (${contextLabel})`,
      );

      const successfulOrderIdList = canonicalResultList
        .filter((item): item is { isSuccess: true; orderId: string; errorText: null } => item !== undefined && item.isSuccess && item.orderId !== null)
        .map((item) => item.orderId);

      if (successfulOrderIdList.length === 0) {
        return {
          isCreated: false,
          orderIdList: [],
          errorText: firstFailureErrorText ?? 'Unknown error',
          isPartial: false,
          placedCount: 0,
          requestedCount: partCount,
          failedPartList,
          placedOrderIdByCanonicalIndex,
        };
      }

      logger.warn(
        { symbol, partCount, placedCount: successfulOrderIdList.length, orderIdList: successfulOrderIdList, contextLabel, ...metadata },
        `[OrderManager] ${symbol} multi-order batch partial success — keeping ${successfulOrderIdList.length} of ${partCount} placed orders (${contextLabel})`,
      );

      return {
        isCreated: true,
        orderIdList: successfulOrderIdList,
        errorText: firstFailureErrorText,
        isPartial: true,
        placedCount: successfulOrderIdList.length,
        requestedCount: partCount,
        failedPartList,
        placedOrderIdByCanonicalIndex,
      };
    }

    const orderIdList = canonicalResultList.map((item) => (item as OpenPositionBatchItemResult).orderId as string);

    return { isCreated: true, orderIdList, errorText: null, isPartial: false, placedCount: partCount, requestedCount: partCount, failedPartList: [], placedOrderIdByCanonicalIndex };
  }

  handleOrderUpdate(event: OrderUpdateEvent): void {
    const entry = this.pendingByOrderId.get(event.orderId);

    if (entry === undefined) {
      return;
    }

    if (!isTerminalStatus(event.status)) {
      return;
    }

    const info = this.buildConfirmedInfoFromEvent(entry, event);

    this.confirmEntry(entry, info).catch((error: unknown) => {
      logger.error({ error, symbol: entry.symbol, orderId: entry.orderId }, `[OrderManager] ${entry.symbol} confirmEntry from WS threw orderId=${entry.orderId}`);
    });
  }

  getDiagnostics(): OrderManagerDiagnostics {
    const nowMs = Date.now();
    let oldestAgeMs = 0;

    for (const entry of this.pendingByOrderId.values()) {
      const ageMs = nowMs - entry.firstAttemptAtMs;

      if (ageMs > oldestAgeMs) {
        oldestAgeMs = ageMs;
      }
    }

    return {
      pendingCount: this.pendingByOrderId.size,
      inFlightCount: this.inFlightOrderIdSet.size,
      oldestAgeMs,
    };
  }

  private async waitForImmediateVerify(entry: PendingCancelEntry, isCancelSent: boolean): Promise<ImmediateCancelOutcome> {
    await sleep(IMMEDIATE_VERIFY_WAIT_MS);

    if (!this.pendingByOrderId.has(entry.orderId)) {
      const immediateResult: ImmediateCancelResult = 'cancelled';

      return { immediateResult, isStillTracked: false };
    }

    const verifyResult = await loggedGetOrder({
      exchangeConnector: this.exchangeConnector,
      symbol: entry.symbol,
      orderId: entry.orderId,
      modulePrefix: '[OrderManager]',
      contextLabel: `immediate-verify ${entry.contextLabel}`,
      errorLevel: 'warn',
      metadata: entry.metadata,
    });

    if (verifyResult.order !== null && isTerminalStatus(verifyResult.order.status)) {
      const info = this.buildConfirmedInfoFromOrder(entry, verifyResult.order, 'rest');

      await this.confirmEntry(entry, info);

      if (info.kind === 'filled' || info.kind === 'partial_then_terminal') {
        return { immediateResult: 'filled', filledAmount: info.filledAmount, avgPrice: info.kind === 'filled' ? info.avgPrice : 0, isStillTracked: false };
      }

      return { immediateResult: 'cancelled', isStillTracked: false };
    }

    if (!isCancelSent) {
      return { immediateResult: 'failed_to_send', isStillTracked: true };
    }

    return { immediateResult: 'pending', isStillTracked: true };
  }

  private async runTick(): Promise<void> {
    const nowMs = Date.now();

    for (const entry of this.pendingByOrderId.values()) {
      if (this.inFlightOrderIdSet.size >= PARALLELISM_LIMIT) {
        break;
      }

      if (entry.cooldownUntilMs > nowMs) {
        continue;
      }

      if (this.inFlightOrderIdSet.has(entry.orderId)) {
        continue;
      }

      if (entry.attemptCount >= MAX_ATTEMPTS) {
        this.exhaustEntry(entry, 'max_attempts').catch((error: unknown) => {
          logger.error({ error, symbol: entry.symbol, orderId: entry.orderId }, `[OrderManager] ${entry.symbol} exhaustEntry threw orderId=${entry.orderId}`);
        });

        continue;
      }

      this.inFlightOrderIdSet.add(entry.orderId);
      entry.cooldownUntilMs = nowMs + PER_ENTRY_COOLDOWN_MS;

      this.processEntry(entry).finally(() => {
        this.inFlightOrderIdSet.delete(entry.orderId);
      });
    }
  }

  private async processEntry(entry: PendingCancelEntry): Promise<void> {
    const cancelResult = await loggedCancelOrder({
      exchangeConnector: this.exchangeConnector,
      symbol: entry.symbol,
      orderId: entry.orderId,
      modulePrefix: '[OrderManager]',
      contextLabel: `retry-tick ${entry.contextLabel} attempt=${entry.attemptCount + 1}`,
      errorLevel: 'warn',
      metadata: entry.metadata,
    });

    entry.attemptCount += 1;
    entry.lastAttemptAtMs = Date.now();

    if (!cancelResult.isSuccess) {
      entry.lastErrorMessage = this.formatErrorMessage(cancelResult.error);
    }

    if (!this.pendingByOrderId.has(entry.orderId)) {
      return;
    }

    const verifyResult = await loggedGetOrder({
      exchangeConnector: this.exchangeConnector,
      symbol: entry.symbol,
      orderId: entry.orderId,
      modulePrefix: '[OrderManager]',
      contextLabel: `retry-verify ${entry.contextLabel} attempt=${entry.attemptCount}`,
      errorLevel: 'warn',
      metadata: entry.metadata,
    });

    if (verifyResult.order !== null && isTerminalStatus(verifyResult.order.status)) {
      const info = this.buildConfirmedInfoFromOrder(entry, verifyResult.order, 'rest');

      await this.confirmEntry(entry, info);
    }
  }

  private async confirmEntry(entry: PendingCancelEntry, info: ConfirmedCancelInfo): Promise<void> {
    if (!this.pendingByOrderId.has(entry.orderId)) {
      return;
    }

    this.pendingByOrderId.delete(entry.orderId);

    const ageMs = Date.now() - entry.firstAttemptAtMs;

    if (info.kind === 'cancelled') {
      logger.info({ symbol: entry.symbol, orderId: entry.orderId, attemptCount: entry.attemptCount, ageMs, source: info.source, contextLabel: entry.contextLabel }, `[OrderManager] ${entry.symbol} confirm cancelled (source=${info.source}, attempts=${entry.attemptCount}, ageMs=${ageMs})`);
    } else if (info.kind === 'filled') {
      logger.info({ symbol: entry.symbol, orderId: entry.orderId, attemptCount: entry.attemptCount, ageMs, source: info.source, filledAmount: info.filledAmount, avgPrice: info.avgPrice, contextLabel: entry.contextLabel }, `[OrderManager] ${entry.symbol} confirm filled (source=${info.source}, filledAmount=${info.filledAmount}, attempts=${entry.attemptCount})`);
    } else {
      logger.info({ symbol: entry.symbol, orderId: entry.orderId, attemptCount: entry.attemptCount, ageMs, source: info.source, filledAmount: info.filledAmount, status: info.status, contextLabel: entry.contextLabel }, `[OrderManager] ${entry.symbol} confirm partial_then_terminal (source=${info.source}, filledAmount=${info.filledAmount}, status=${info.status}, attempts=${entry.attemptCount})`);
    }

    for (const callback of entry.onConfirmedList) {
      try {
        await callback(info);
      } catch (error: unknown) {
        logger.error({ error, symbol: entry.symbol, orderId: entry.orderId }, `[OrderManager] ${entry.symbol} onConfirmed callback threw orderId=${entry.orderId}`);
      }
    }
  }

  private async exhaustEntry(entry: PendingCancelEntry, reason: ExhaustedReason): Promise<void> {
    if (!this.pendingByOrderId.has(entry.orderId)) {
      return;
    }

    this.pendingByOrderId.delete(entry.orderId);

    const ageMs = Date.now() - entry.firstAttemptAtMs;
    const info: ExhaustedCancelInfo = {
      orderId: entry.orderId,
      reason,
      attemptCount: entry.attemptCount,
      ageMs,
      lastErrorMessage: entry.lastErrorMessage,
    };

    logger.error({ symbol: entry.symbol, orderId: entry.orderId, attemptCount: entry.attemptCount, ageMs, reason, lastErrorMessage: entry.lastErrorMessage, contextLabel: entry.contextLabel }, `[OrderManager] ${entry.symbol} EXHAUSTED (reason=${reason}, attempts=${entry.attemptCount}, contextLabel=${entry.contextLabel}, orderId=${entry.orderId})`);

    if (reason === 'max_attempts') {
      this.telegramNotifier.sendMessage(`⚠️ ${entry.symbol} cancel EXHAUSTED — ${entry.contextLabel}: orderId=${entry.orderId} after ${entry.attemptCount} attempts. Manual review on exchange.`).catch((error: unknown) => {
        logger.error({ error }, '[OrderManager] Failed to send exhausted alert to Telegram');
      });
    }

    for (const callback of entry.onExhaustedList) {
      try {
        await callback(info);
      } catch (error: unknown) {
        logger.error({ error, symbol: entry.symbol, orderId: entry.orderId }, `[OrderManager] ${entry.symbol} onExhausted callback threw orderId=${entry.orderId}`);
      }
    }
  }

  private runHeartbeat(): void {
    const diagnostics = this.getDiagnostics();
    const isIdle = diagnostics.pendingCount === 0 && diagnostics.inFlightCount === 0;
    const heartbeatPayload = { pendingCount: diagnostics.pendingCount, inFlightCount: diagnostics.inFlightCount, oldestAgeMs: diagnostics.oldestAgeMs };
    const heartbeatMessage = `[OrderManager] heartbeat pendingCount=${diagnostics.pendingCount} inFlight=${diagnostics.inFlightCount} oldestAgeMs=${diagnostics.oldestAgeMs}`;

    if (isIdle) {
      this.heartbeatLogThrottle.throttled({ logger, level: 'info', key: 'heartbeat-idle', windowMs: IDLE_HEARTBEAT_LOG_THROTTLE_MS, payload: heartbeatPayload, message: heartbeatMessage });
    } else {
      logger.info(heartbeatPayload, heartbeatMessage);
    }

    if (diagnostics.pendingCount === 0) {
      this.lastAlertHash = null;

      return;
    }

    const nowMs = Date.now();
    const stuckEntryList = Array.from(this.pendingByOrderId.values()).filter((entry) => nowMs - entry.firstAttemptAtMs >= ALERT_THRESHOLD_AGE_MS);

    if (stuckEntryList.length === 0) {
      return;
    }

    const sortedIdList = stuckEntryList.map((entry) => entry.orderId).sort();
    const alertHash = sortedIdList.join(',');

    if (alertHash === this.lastAlertHash) {
      return;
    }

    this.lastAlertHash = alertHash;

    const lineList = stuckEntryList.map((entry) => `${entry.symbol} ${entry.orderId} (${entry.contextLabel}, attempts=${entry.attemptCount}, age=${Math.round((nowMs - entry.firstAttemptAtMs) / 1000)}s)`);
    const message = `⚠️ OrderManager — ${stuckEntryList.length} cancel(s) stuck >10s:\n${lineList.join('\n')}`;

    this.telegramNotifier.sendMessage(message).catch((error: unknown) => {
      logger.error({ error }, '[OrderManager] Failed to send heartbeat aggregated alert to Telegram');
    });
  }

  private buildConfirmedInfoFromOrder(entry: PendingCancelEntry, order: { status: string; filledAmount?: number; avgPrice?: number }, source: 'ws' | 'rest'): ConfirmedCancelInfo {
    const ageMs = Date.now() - entry.firstAttemptAtMs;
    const filledAmount = order.filledAmount ?? 0;

    if (order.status === 'closed') {
      return { kind: 'filled', orderId: entry.orderId, filledAmount, avgPrice: order.avgPrice ?? 0, source, attemptCount: entry.attemptCount, ageMs };
    }

    if ((order.status === 'canceled' || order.status === 'expired') && filledAmount > 0) {
      return { kind: 'partial_then_terminal', orderId: entry.orderId, filledAmount, status: order.status, source, attemptCount: entry.attemptCount, ageMs };
    }

    return { kind: 'cancelled', orderId: entry.orderId, source, attemptCount: entry.attemptCount, ageMs };
  }

  private buildConfirmedInfoFromEvent(entry: PendingCancelEntry, event: OrderUpdateEvent): ConfirmedCancelInfo {
    const ageMs = Date.now() - entry.firstAttemptAtMs;
    const filledAmount = event.filledAmount ?? 0;

    if (event.status === 'closed') {
      return { kind: 'filled', orderId: entry.orderId, filledAmount, avgPrice: event.avgPrice ?? 0, source: 'ws', attemptCount: entry.attemptCount, ageMs };
    }

    if ((event.status === 'canceled' || event.status === 'expired') && filledAmount > 0) {
      return { kind: 'partial_then_terminal', orderId: entry.orderId, filledAmount, status: event.status, source: 'ws', attemptCount: entry.attemptCount, ageMs };
    }

    return { kind: 'cancelled', orderId: entry.orderId, source: 'ws', attemptCount: entry.attemptCount, ageMs };
  }

  private formatErrorMessage(error: unknown): string {
    if (error === null || error === undefined) {
      return 'Unknown error';
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private async runSerializedByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existingLock = this.serializationByKey.get(key) ?? Promise.resolve();
    const newPromise = existingLock.catch(() => undefined).then(() => fn());

    this.serializationByKey.set(key, newPromise);

    try {
      return await newPromise;
    } finally {
      if (this.serializationByKey.get(key) === newPromise) {
        this.serializationByKey.delete(key);
      }
    }
  }
}

export { OrderManager };
export type { OrderManagerArgs };
