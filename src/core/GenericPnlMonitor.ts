import { createBot, createLoadingController, createMenuReplacer, createMessageTracker, createSender, escapeMarkdownV2WithFormatting, isBenignTelegramEditError } from '@solncebro/telegram-engine';
import type { BotInstance, LoadingController, LoadingHandle, LoadingMode, MenuLogLevel, MenuReplacer, MenuSurface, MessageTracker, ReplaceMenuArgs, TelegramSender } from '@solncebro/telegram-engine';
import type { Context, Telegraf } from 'telegraf';

import type { AutoTpToggleOptions, GenericPnlMonitorArgs, InsuranceViewState, MonitoringFlagFieldName, PnlAlertButton, PositionsReplyContext, PositionViewState, TpSplitContext, TpSplitParsedMode, TpSplitPlanPart, TpSplitState } from './GenericPnlMonitor.types';
import { logger } from './logger';
import { PositionMonitor } from './PositionMonitor';
import { IMPORTED_POSITION_MA_LEVEL, MIN_STOP_LOSS_LEVEL, PNL_POLL_INTERVAL_MS } from './PositionMonitor';
import type { PositionRemovedExternallyNotifyArgs } from './PositionMonitor.types';

import { formatDirection, formatExchangeLabel } from '../telegram/pnlMessageFormatHelpers';
import {
  formatAutoCloseCancelledMessage,
  formatAutoCloseMessage,
  formatAutoTpMenuMessage,
  formatEphemeralPositionDetailMessage,
  formatExternalMultiEntryCancelMessage,
  formatHalfClosedMessage,
  formatLossAlertMessage,
  formatPendingEntriesCancelledMessage,
  formatPositionClosedMessage,
  formatPositionDetailMessage,
  formatPositionRemovedExternallyMessage,
  formatPositionsListMessage,
  formatProfitAlertMessage,
  formatSosCancelledMessage,
  formatSosMarkedMessage,
  formatTpCancelledMessage,
  formatTpSplitConfirmation,
  formatTpSplitCreatedMessage,
} from '../telegram/pnlMessageTemplates';
import type { EphemeralPositionListItem, MaValueWithOffset, PositionDetailMessageArgs, PositionListItem, StopLossStatus } from '../telegram/pnlMessageTemplates.types';
import type { MaLevel, MonitoredPosition, Position } from '../types/index';
import { MA_LEVEL_LIST, MarketTypeEnum } from '../types/index';
import { EMOJI_CHECK, EMOJI_CROSS, EMOJI_DOOR, EMOJI_LONG_DOT, EMOJI_PROFIT, EMOJI_ROBOT, EMOJI_SETTINGS, EMOJI_SHORT_DOT, EMOJI_SOS, EMOJI_TARGET } from '../utils/emoji';
import { resolveGuardedExtremePrice } from '../utils/entryKlineGuard';
import { calculateBreakevenPrice, calculatePercentChange, getMaValue } from '../utils/indicators';
import { startIntervalScheduler } from '../utils/intervalScheduler';
import { deriveOrderPlan } from '../utils/orderSize';
import { parseOrderSizeInput } from '../utils/orderSizeInput';
import { buildAmountList, buildPriceList, parseFirstPriceInput, parseModeInput, validatePriceVsLast } from '../utils/tpSplit';

const LOADING_TEXT = '⏳ Loading...';

const ALARM_INTERVAL_MS = 30_000;
// Debounce window to aggregate externally-cancelled multi-entry events into one Telegram message per position.
const EXTERNAL_CANCEL_FLUSH_DEBOUNCE_MS = 1_500;
// Per-tick diagnostic logs (loss/breakeven fired by extreme touch) are throttled per
// position so a single hot position cannot flood the log on every reactive tick.
const DIAGNOSTIC_LOG_THROTTLE_MS = 300_000;

const PNL_MENU_BUTTON_POSITIONS = '💠 Positions';
const PNL_MENU_BUTTON_CLOSE = '✖️ Close menu';

const PNL_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: PNL_MENU_BUTTON_POSITIONS }, { text: PNL_MENU_BUTTON_CLOSE }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

type ContextWithMatch = Context & { match: RegExpExecArray };


class GenericPnlMonitor extends PositionMonitor {
  protected readonly chatId: string;
  protected readonly messageTracker: MessageTracker;
  protected readonly menuReplacer: MenuReplacer;
  protected readonly loadingController: LoadingController;
  // Centralized sender from telegram-engine — all message send/edit/delete go through it, no direct
  // bot.telegram sending of its own. getBot is lazy: the bot is created later in setupBot().
  protected readonly sender: TelegramSender;
  protected botInstance: BotInstance | null = null;
  protected alarmTimerByPositionId: Map<string, NodeJS.Timeout> = new Map();
  protected alarmTypeByPositionId: Map<string, 'profit' | 'loss'> = new Map();
  protected profitAlarmThresholdByPositionId: Map<string, number> = new Map();
  protected readonly pnlBotToken: string;
  protected tpSplitState: TpSplitState | null = null;
  protected readonly getPnlConfig: GenericPnlMonitorArgs['getPnlConfig'];

  constructor(args: GenericPnlMonitorArgs) {
    super({
      exchangeConnector: args.exchangeConnector,
      orderManager: args.orderManager,
      marketDataManagerByInterval: args.marketDataManagerByInterval,
      positionMode: args.positionMode,
      positionStore: args.positionStore,
    });
    this.chatId = args.chatId;
    this.pnlBotToken = args.pnlBotToken;
    this.getPnlConfig = args.getPnlConfig;
    this.messageTracker = createMessageTracker();
    this.menuReplacer = createMenuReplacer({
      resolveSurface: () => this.resolveSurface(),
      onLog: (level, message, meta) => this.logMenuEvent(level, message, meta),
    });
    this.loadingController = createLoadingController({
      menuReplacer: this.menuReplacer,
      resolveSurface: () => this.resolveSurface(),
      defaultLoadingText: LOADING_TEXT,
      onLog: (level, message, meta) => this.logMenuEvent(level, message, meta),
    });
    this.sender = createSender({
      getBot: () => this.botInstance?.bot,
      onLog: (message, data) => logger.warn(data ?? {}, `[PnlMonitor] ${message}`),
    });
  }

  protected registerInsuranceCallbackHandlers(_bot: Telegraf): void {}

  protected async onLossThresholdReached(_position: MonitoredPosition): Promise<void> {}

  protected async onHalveCompleted(_position: MonitoredPosition): Promise<void> {}

  protected async onCancelSos(_position: MonitoredPosition): Promise<{ cancelledInsuranceMaLevel: MaLevel | null }> {
    return { cancelledInsuranceMaLevel: null };
  }

  protected resolveInsuranceViewState(_position: MonitoredPosition): InsuranceViewState {
    return { hasInsurance: false, insuranceMaLevel: null, isInsuranceMissing: false };
  }

  protected getTpSizePresetRowList(): PnlAlertButton[][] {
    return [];
  }

  protected resolveNextMaLevel(_maLevel: MaLevel): MaLevel | null {
    return null;
  }

  private resolveSurface(): MenuSurface | null {
    const bot = this.botInstance?.bot;

    if (!bot) {
      return null;
    }

    return { telegram: bot.telegram, chatId: this.chatId, tracker: this.messageTracker };
  }

  private logMenuEvent(level: MenuLogLevel, message: string, meta?: Record<string, unknown>): void {
    if (level === 'error') {
      logger.error(meta ?? {}, `[PnlMonitor] ${message}`);

      return;
    }

    logger.warn(meta ?? {}, `[PnlMonitor] ${message}`);
  }

  async initialize(): Promise<void> {
    await this.setupBot();
    await this.restoreMonitoredPositions();
    await this.onAfterPositionsRestored();
    this.startPolling();

    await this.sendMessage(`PNL Monitor initialized (${this.positionById.size} positions)`);

    logger.info({ positionCount: this.positionById.size }, `[PnlMonitor] Initialized (${this.positionById.size} monitored positions)`);
  }

  protected createBotInstance(args: Parameters<typeof createBot>[0]): BotInstance {
    return createBot(args);
  }

  protected async setupBot(): Promise<void> {
    // createBot attaches a crash guard internally; onError logs any suppressed handler error so a
    // single failing button can never abort the PnL bot's polling (see botCrashGuard in telegram-engine).
    this.botInstance = this.createBotInstance({
      botToken: this.pnlBotToken,
      botName: 'PnlMonitor',
      onError: (error, botName) => {
        logger.error({ error, botName }, '[PnlMonitor] Unhandled handler error — suppressed to keep polling alive');
        // Also ping the chat so the error is visible immediately, not only in the logs.
        const errorText = error instanceof Error ? error.message : String(error);
        const shortText = errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;

        this.sendMessage(`⚠️ Oops — a PnL bot handler errored (still alive, not frozen):\n${shortText}`).catch((sendError: unknown) => {
          logger.warn({ error: sendError }, '[PnlMonitor] Failed to send handler-error notice');
        });
      },
    });
    this.registerCallbackHandlers(this.botInstance.bot);

    await this.botInstance.bot.telegram.setMyCommands([
      { command: 'menu', description: 'PNL Monitor menu' },
    ]);

    this.botInstance.launch().catch((error: unknown) => {
      logger.error({ error }, '[PnlMonitor] PNL bot launch failed');
    });
  }

  // Subclass extension points around position restore. onPositionRestoring fires
  // BEFORE the exchange verify (capture legacy fields prior to normalization);
  // onPositionRestored fires AFTER the position landed in positionById (every
  // restored branch: present / ambiguous / absent-unconfirmed / verify-error);
  // onAfterPositionsRestored fires once after the whole restore pass, BEFORE
  // polling starts — for cross-position steps (aggregation, marks).
  protected async onPositionRestoring(_positionId: string, _position: MonitoredPosition): Promise<void> {}
  protected async onPositionRestored(_positionId: string, _position: MonitoredPosition): Promise<void> {}
  protected async onAfterPositionsRestored(): Promise<void> {}

  protected async restoreMonitoredPositions(): Promise<void> {
    const positionDocument = await this.positionStore.loadMonitoredPositions();

    for (const [id, position] of Object.entries(positionDocument)) {
      if (!position.symbol) {
        logger.warn(
          { positionId: id },
          `[PnlMonitor] Skipping + removing zombie monitored position ${id} on restore — missing symbol (likely Firestore dot-path write artifact)`,
        );
        await this.positionStore.removeMonitoredPosition(id);

        continue;
      }

      await this.onPositionRestoring(id, position);

      try {
        logger.info(
          { positionId: id, symbol: position.symbol, direction: position.direction },
          `[PnlMonitor] ${position.symbol} readPositionState request (initialize)`,
        );
        const stateResult = await this.exchangeConnector.positionManager.readPositionState({
          symbol: position.symbol,
          marketType: MarketTypeEnum.Futures,
          direction: position.direction,
        });
        logger.info(
          { positionId: id, symbol: position.symbol, kind: stateResult.kind, direction: position.direction },
          `[PnlMonitor] ${position.symbol} readPositionState response kind=${stateResult.kind} (initialize)`,
        );

        if (stateResult.kind === 'ambiguous') {
          logger.warn(
            { positionId: id, symbol: position.symbol, ambiguityReason: stateResult.reason, exchangeContracts: stateResult.position.contracts, exchangeSide: stateResult.position.side, positionIdx: stateResult.position.positionIdx ?? null, rawInfo: stateResult.position.info },
            `[PnlMonitor] ${position.symbol} readPositionState returned ambiguous (reason=${stateResult.reason}) on restart — restoring without verify (NOT removing) [initialize]`,
          );
          this.normalizeLegacyPosition(position);
          this.positionById.set(id, position);
          await this.onPositionRestored(id, position);

          continue;
        }

        if (stateResult.kind === 'absent' && stateResult.confidence === 'unconfirmed') {
          logger.warn(
            { positionId: id, symbol: position.symbol, reason: stateResult.reason, errorText: stateResult.errorText ?? null },
            `[PnlMonitor] ${position.symbol} readPositionState returned absent/unconfirmed on restart (reason=${stateResult.reason}) — restoring without verify`,
          );
          this.normalizeLegacyPosition(position);
          this.positionById.set(id, position);
          await this.onPositionRestored(id, position);

          continue;
        }

        if (stateResult.kind === 'absent') {
          this.normalizeLegacyPosition(position);
          await this.cleanupExchangeOrdersOnExternalClose(position);
          await this.positionStore.removeMonitoredPosition(id);
          logger.info({ positionId: id, symbol: position.symbol, reason: stateResult.reason }, `[PnlMonitor] ${position.symbol} Position closed (reason=${stateResult.reason}), removing from monitoring (SL/TP cancelled if any)`);

          continue;
        }

        const exchangePosition = stateResult.position;

        position.contracts = exchangePosition.contracts;
        this.normalizeLegacyPosition(position);
        this.positionById.set(id, position);
        await this.onPositionRestored(id, position);

        logger.info({ positionId: id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Restored monitored position`);
      } catch (error: unknown) {
        logger.warn({ error, positionId: id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to verify position on restart`);
        this.normalizeLegacyPosition(position);
        this.positionById.set(id, position);
        await this.onPositionRestored(id, position);
      }
    }
  }

  protected startPolling(): void {
    this.pollSchedulerHandle = startIntervalScheduler({
      tickHandler: () => this.pollPositions(),
      intervalMs: PNL_POLL_INTERVAL_MS,
      contextLabel: '[PnlMonitor] Poll cycle failed',
    });

    for (const [interval, marketDataManager] of this.marketDataManagerByInterval.entries()) {
      this.subscribeToMarketDataManager(interval, marketDataManager);
    }
  }


  async shutdown(): Promise<void> {
    if (this.pollSchedulerHandle !== null) {
      this.pollSchedulerHandle.stop();
      this.pollSchedulerHandle = null;
    }

    for (const [positionId, timer] of this.alarmTimerByPositionId) {
      clearInterval(timer);
      this.alarmTimerByPositionId.delete(positionId);
      this.alarmTypeByPositionId.delete(positionId);
    }

    this.consecutiveClosedPollTickCountByPositionId.clear();
    this.lastReadStateKindByPositionId.clear();
    this.profitAlarmThresholdByPositionId.clear();

    if (this.externalCancelFlushTimer !== null) {
      clearTimeout(this.externalCancelFlushTimer);
      this.externalCancelFlushTimer = null;
    }
    this.externalCancelBufferByPositionId.clear();
    this.botCancelledMultiEntryOrderIdExpiryMap.clear();

    if (this.botInstance) {
      await this.botInstance.stop('shutdown');
    }

    logger.info('[PnlMonitor] Shutdown complete');
  }

  protected onCloseAwaitingTick(positionId: string): void {
    this.stopAlarm(positionId);
  }

  protected async notifyPositionRemovedExternally(args: PositionRemovedExternallyNotifyArgs): Promise<void> {
    const message = formatPositionRemovedExternallyMessage({
      symbol: args.symbol,
      timeframe: args.timeframe,
      direction: args.direction,
      maLevel: args.maLevel,
      isAugmented: args.isAugmented,
      lastPnlPercent: args.lastPnlPercent,
      confirmationTickCount: args.confirmationTickCount,
      confirmationWindowSeconds: args.confirmationWindowSeconds,
    });

    try {
      await this.sendMessage(message);
    } catch (error: unknown) {
      logger.warn(
        { error, symbol: args.symbol },
        `[PnlMonitor] ${args.symbol} Failed to send external-close removal notification`,
      );
    }
  }

  protected async onPollActivePosition(position: MonitoredPosition, lastPrice: number): Promise<void> {
    const pnlPercent = this.calculatePnlPercent(position, lastPrice);
    const { favourable: favourableExtremePnlPercent, unfavourable: unfavourableExtremePnlPercent } = this.computeDecisionPnlPercents(position, pnlPercent, lastPrice);
    const halveDecisionPnlPercent = this.computeHalveDecisionPnlPercent(position, pnlPercent, favourableExtremePnlPercent);

    const isAutoClosed = await this.checkAutoClose(position, pnlPercent, lastPrice, favourableExtremePnlPercent);

    if (isAutoClosed) {
      return;
    }

    const isHalved = await this.checkBreakevenHalfClose(position, pnlPercent, lastPrice, halveDecisionPnlPercent);

    if (isHalved) {
      return;
    }

    this.checkProfitThreshold(position, pnlPercent);
    await this.checkLossThreshold(position, pnlPercent, unfavourableExtremePnlPercent);
  }

  private async checkAutoClose(position: MonitoredPosition, pnlPercent: number, lastPrice: number, decisionPnlPercent?: number): Promise<boolean> {
    if (!position.isAutoCloseEnabled) {
      return false;
    }

    const settings = { pnlMonitor: this.getPnlConfig() };

    if (settings.pnlMonitor.profitAutoClosePercent === 0) {
      return false;
    }

    const firePnlPercent = decisionPnlPercent ?? pnlPercent;

    if (firePnlPercent < settings.pnlMonitor.profitAutoClosePercent) {
      return false;
    }

    if (firePnlPercent !== pnlPercent) {
      logger.info(
        { positionId: position.id, symbol: position.symbol, pnlPercent, decisionPnlPercent: firePnlPercent, threshold: settings.pnlMonitor.profitAutoClosePercent, direction: position.direction },
        `[PnlMonitor] ${position.symbol} Auto-close fired by extreme touch (decision pnl=${firePnlPercent.toFixed(2)}% vs render pnl=${pnlPercent.toFixed(2)}%, threshold=${settings.pnlMonitor.profitAutoClosePercent}%) [${position.timeframe}]`,
      );
    }

    if (position.isUserResponded) {
      if (!position.isAutoCloseNotified) {
        position.isAutoCloseNotified = true;
        await this.safeUpdateMonitoredPosition(position.id, { isAutoCloseNotified: true });

        const message = formatAutoCloseCancelledMessage({
          symbol: position.symbol,
          timeframe: position.timeframe,
          direction: position.direction,
          maLevel: position.maLevel,
          thresholdPercent: settings.pnlMonitor.profitAutoClosePercent,
          entryPrice: position.entryPrice,
          isAugmented: position.isAugmented,
        });

        await this.sendMessage(message);
      }

      return false;
    }

    await this.closePosition(position);

    const message = formatAutoCloseMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      pnlPercent,
      entryPrice: position.entryPrice,
      lastPrice,
      maLevel: position.maLevel,
      isAugmented: position.isAugmented,
    });

    await this.sendMessage(message);
    await this.removePosition(position.id);

    logger.info({ positionId: position.id, symbol: position.symbol, pnlPercent }, `[PnlMonitor] ${position.symbol} Auto-closed at PNL +${pnlPercent.toFixed(1)}%`);

    return true;
  }

  private async checkBreakevenHalfClose(position: MonitoredPosition, pnlPercent: number, lastPrice: number, decisionPnlPercent?: number): Promise<boolean> {
    if (!position.isHalveAtBreakevenEnabled) {
      return false;
    }

    const breakevenHalfClosePercent = this.getPnlConfig().breakevenHalfClosePercent;
    const firePnlPercent = decisionPnlPercent ?? pnlPercent;

    if (firePnlPercent < breakevenHalfClosePercent) {
      return false;
    }

    const halfContractsRaw = position.contracts / 2;
    const preciseHalfContractsString = this.exchangeConnector.futures.amountToPrecision(position.symbol, halfContractsRaw);
    const halfContracts = Number(preciseHalfContractsString);

    if (firePnlPercent !== pnlPercent) {
      this.logThrottle.throttled({
        logger,
        level: 'info',
        key: `bhcfire:${position.id}`,
        windowMs: DIAGNOSTIC_LOG_THROTTLE_MS,
        payload: { positionId: position.id, symbol: position.symbol, pnlPercent, decisionPnlPercent: firePnlPercent, breakevenHalfClosePercent, halfContracts, totalContracts: position.contracts, direction: position.direction, timeframe: position.timeframe },
        message: `[PnlMonitor] ${position.symbol} Breakeven half-close fired by extreme touch (decision pnl=${firePnlPercent.toFixed(2)}% vs render pnl=${pnlPercent.toFixed(2)}%, threshold=${breakevenHalfClosePercent}%), halving ${halfContracts} contracts (of ${position.contracts}) [${position.timeframe}]`,
      });
    } else {
      this.logThrottle.throttled({
        logger,
        level: 'info',
        key: `bhcfire:${position.id}`,
        windowMs: DIAGNOSTIC_LOG_THROTTLE_MS,
        payload: { positionId: position.id, symbol: position.symbol, pnlPercent, breakevenHalfClosePercent, halfContracts, totalContracts: position.contracts, direction: position.direction, timeframe: position.timeframe },
        message: `[PnlMonitor] ${position.symbol} Breakeven half-close fired at PNL +${pnlPercent.toFixed(2)}%, halving ${halfContracts} contracts (of ${position.contracts}) [${position.timeframe}]`,
      });
    }

    const { isSuccess: isOrderPlaced, errorText } = await this.orderManager.enqueueClosePositionMarket({
      positionId: position.id,
      symbol: position.symbol,
      direction: position.direction,
      amount: halfContracts,
      contextLabel: `breakeven half-close [${position.timeframe}]`,
      metadata: { halfContracts, totalContracts: position.contracts },
    });

    if (!isOrderPlaced) {
      await this.sendMessage(`${EMOJI_CROSS} ${position.symbol} Breakeven half-close failed: ${errorText ?? 'Unknown error'}`);
    }

    const remainingContracts = isOrderPlaced ? Math.max(0, position.contracts - halfContracts) : position.contracts;

    position.contracts = remainingContracts;
    position.isHalveAtBreakevenEnabled = false;
    position.hasInsuranceCycleCompleted = true;
    position.isLossAlertAcknowledged = false;
    position.isInsuranceUnavailableNotified = false;
    position.insuranceChaserId = null;
    position.insuranceFailReason = null;
    position.lastAcknowledgedThreshold = 0;
    this.profitAlarmThresholdByPositionId.delete(position.id);
    position.isUserResponded = false;
    position.isAutoCloseNotified = false;
    position.lastAlertMessageId = null;
    position.halveEnableKlineHighSnapshot = null;
    position.halveEnableKlineLowSnapshot = null;
    position.halveEnableKlineOpenTimestamp = null;

    await this.safeUpdateMonitoredPosition(position.id, {
      contracts: position.contracts,
      isHalveAtBreakevenEnabled: false,
      hasInsuranceCycleCompleted: true,
      isLossAlertAcknowledged: false,
      isInsuranceUnavailableNotified: false,
      insuranceChaserId: null,
      insuranceFailReason: null,
      lastAcknowledgedThreshold: 0,
      isUserResponded: false,
      isAutoCloseNotified: false,
      lastAlertMessageId: null,
      halveEnableKlineHighSnapshot: null,
      halveEnableKlineLowSnapshot: null,
      halveEnableKlineOpenTimestamp: null,
    });

    logger.info(
      { positionId: position.id, symbol: position.symbol, remainingContracts, isOrderPlaced, hasInsuranceCycleCompleted: true },
      `[PnlMonitor] ${position.symbol} Halve cycle reset after breakeven half-close attempt (isOrderPlaced=${isOrderPlaced}, hasInsuranceCycleCompleted=true) — position back to normal monitoring, insurance creation locked for the rest of position lifetime`,
    );

    try {
      await this.drainMultiEntryListAndPersist(position, 'after breakeven half-close');
    } catch (error: unknown) {
      logger.warn(
        { error, positionId: position.id, symbol: position.symbol },
        `[PnlMonitor] ${position.symbol} Failed to drain multi-entry orders after halve — OrderManager retries via cancel tracker, list cleared in RAM/Firebase`,
      );
    }

    await this.onHalveCompleted(position);

    if (isOrderPlaced) {
      const message = formatHalfClosedMessage({
        symbol: position.symbol,
        timeframe: position.timeframe,
        direction: position.direction,
        maLevel: position.maLevel,
        entryPrice: position.entryPrice,
        pnlPercent,
        lastPrice,
        closedContracts: halfContracts,
        remainingContracts,
        isAugmented: position.isAugmented,
      });

      const messageId = await this.sendMessage(message);

      if (messageId === null) {
        logger.error(
          { positionId: position.id, symbol: position.symbol, halfContracts, remainingContracts, pnlPercent },
          `[PnlMonitor] ${position.symbol} Failed to deliver halve notification to Telegram (sendMessage returned null) — halve already executed on exchange`,
        );
      } else {
        logger.info(
          { positionId: position.id, symbol: position.symbol, messageId, halfContracts, remainingContracts },
          `[PnlMonitor] ${position.symbol} Halve notification sent (messageId=${messageId})`,
        );
      }
    }

    return true;
  }

  private checkProfitThreshold(position: MonitoredPosition, pnlPercent: number): void {
    const settings = this.getPnlConfig();
    const step = settings.profitThresholdPercent;

    if (step <= 0 || pnlPercent < step) {
      return;
    }

    if (position.isTrailingSlEnabled) {
      const trailingStopLossLevel = Math.max(pnlPercent - step, MIN_STOP_LOSS_LEVEL);
      const isFirstStopLoss = position.stopLossOrderId === null;
      const trailDeltaPercent = trailingStopLossLevel - position.currentStopLossLevel;
      const trailingStep = settings.trailingStopLossStepPercent;

      if (isFirstStopLoss || trailDeltaPercent >= trailingStep) {
        logger.info(
          { positionId: position.id, symbol: position.symbol, pnlPercent, trailingStopLossLevel, currentStopLossLevel: position.currentStopLossLevel, trailDeltaPercent, trailingStep, isFirstStopLoss },
          `[PnlMonitor] ${position.symbol} Trail SL: pnl=${pnlPercent.toFixed(2)}% → SL=${trailingStopLossLevel.toFixed(2)}% (Δ=${trailDeltaPercent.toFixed(2)}% from currentStopLossLevel=${position.currentStopLossLevel.toFixed(2)}%, isFirstStopLoss=${isFirstStopLoss})`,
        );

        this.updateStopLoss(position, trailingStopLossLevel).catch((error: unknown) => {
          logger.error({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} updateStopLoss rejected unexpectedly`);
        });
      }
    }

    if (!position.isPnlAlertsEnabled) {
      if (this.alarmTypeByPositionId.get(position.id) === 'profit') {
        this.stopAlarm(position.id);
      }

      return;
    }

    const currentThreshold = Math.floor(pnlPercent / step) * step;

    if (currentThreshold > position.lastAcknowledgedThreshold) {
      const previousArmedThreshold = this.profitAlarmThresholdByPositionId.get(position.id) ?? 0;

      if (currentThreshold > previousArmedThreshold) {
        this.profitAlarmThresholdByPositionId.set(position.id, currentThreshold);
      }

      if (!this.alarmTimerByPositionId.has(position.id)) {
        this.startAlarm(position.id, 'profit');
      }
    } else if (this.alarmTypeByPositionId.get(position.id) === 'profit') {
      this.stopAlarm(position.id);
    }
  }

  private async checkLossThreshold(position: MonitoredPosition, pnlPercent: number, decisionPnlPercent?: number): Promise<void> {
    const settings = { pnlMonitor: this.getPnlConfig() };
    const firePnlPercent = decisionPnlPercent ?? pnlPercent;

    if (firePnlPercent > -settings.pnlMonitor.lossThresholdPercent) {
      this.stopAlarmIfLoss(position.id);

      return;
    }

    if (!position.isPnlAlertsEnabled) {
      this.stopAlarmIfLoss(position.id);

      return;
    }

    if (firePnlPercent !== pnlPercent) {
      this.logThrottle.throttled({
        logger,
        level: 'info',
        key: `lossfire:${position.id}`,
        windowMs: DIAGNOSTIC_LOG_THROTTLE_MS,
        payload: { positionId: position.id, symbol: position.symbol, pnlPercent, decisionPnlPercent: firePnlPercent, threshold: -settings.pnlMonitor.lossThresholdPercent, direction: position.direction },
        message: `[PnlMonitor] ${position.symbol} Loss threshold fired by extreme touch (decision pnl=${firePnlPercent.toFixed(2)}% vs render pnl=${pnlPercent.toFixed(2)}%, threshold=${-settings.pnlMonitor.lossThresholdPercent}%) [${position.timeframe}]`,
      });
    }

    await this.onLossThresholdReached(position);
  }

  protected startAlarm(positionId: string, type: 'profit' | 'loss'): void {
    if (this.alarmTimerByPositionId.has(positionId)) {
      return;
    }

    this.sendAlarmMessage(positionId, type).catch((error: unknown) => {
      logger.warn({ error, positionId }, '[PnlMonitor] Failed to send initial alarm message');
    });

    const timer = setInterval(() => {
      this.sendAlarmMessage(positionId, type).catch((error: unknown) => {
        logger.warn({ error, positionId }, '[PnlMonitor] Failed to send alarm message');
      });
    }, ALARM_INTERVAL_MS);
    timer.unref();

    this.alarmTimerByPositionId.set(positionId, timer);
    this.alarmTypeByPositionId.set(positionId, type);
  }

  protected stopAlarm(positionId: string): void {
    const timer = this.alarmTimerByPositionId.get(positionId);

    if (timer) {
      clearInterval(timer);
      this.alarmTimerByPositionId.delete(positionId);
      this.alarmTypeByPositionId.delete(positionId);
    }
  }

  private stopAlarmIfLoss(positionId: string): void {
    if (this.alarmTypeByPositionId.get(positionId) === 'loss') {
      this.stopAlarm(positionId);
    }
  }

  protected async sendOneShotLossAlert(positionId: string): Promise<void> {
    const position = this.positionById.get(positionId);

    if (!position) {
      return;
    }

    if (!this.botInstance) {
      return;
    }

    if (position.lastAlertMessageId) {
      try {
        await this.sender.editMessageReplyMarkup(this.chatId, position.lastAlertMessageId, { inline_keyboard: [] });
      } catch (error: unknown) {
        logger.warn({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to clear old alert buttons`);
      }
    }

    const lastPrice = this.getLastPriceFromKline(position.symbol);
    const pnlPercent = this.calculatePnlPercent(position, lastPrice);
    const nextMaLevel = this.resolveNextMaLevel(position.maLevel);

    const messageText = formatLossAlertMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      pnlPercent,
      entryPrice: position.entryPrice,
      lastPrice,
      maLevel: position.maLevel,
      isInsuranceCreated: false,
      isInsuranceLinked: false,
      insuranceMaLevel: nextMaLevel,
      insuranceFailReason: position.insuranceFailReason,
      isAugmented: position.isAugmented,
    });

    const buttonList: PnlAlertButton[] = [{ text: '✅ OK', callback_data: `pnl_loss_ok:${positionId}` }];

    try {
      const messageId = await this.sender.sendMessage({
        message: escapeMarkdownV2WithFormatting(messageText),
        peer: this.chatId,
        useMarkdownV2: true,
        returnMessageId: true,
        replyMarkup: { inline_keyboard: [buttonList] },
      });

      if (typeof messageId === 'number') {
        position.lastAlertMessageId = messageId;

        logger.info(
          { positionId: position.id, symbol: position.symbol, messageId },
          `[PnlMonitor] ${position.symbol} One-shot loss alert sent (messageId=${messageId})`,
        );
      }
    } catch (error: unknown) {
      logger.warn({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to send one-shot loss alert`);
    }
  }

  private async sendAlarmMessage(positionId: string, type: 'profit' | 'loss'): Promise<void> {
    const position = this.positionById.get(positionId);

    if (!position) {
      this.stopAlarm(positionId);

      return;
    }

    logger.info(
      { positionId: position.id, symbol: position.symbol, type, stopLossOrderId: position.stopLossOrderId, currentStopLossLevel: position.currentStopLossLevel, lastAlertMessageId: position.lastAlertMessageId },
      `[PnlMonitor] ${position.symbol} sendAlarmMessage start type=${type} stopLossOrderId=${position.stopLossOrderId ?? 'null'} currentStopLossLevel=${position.currentStopLossLevel}%`,
    );

    if (!this.botInstance) {
      return;
    }

    if (position.lastAlertMessageId) {
      try {
        await this.sender.editMessageReplyMarkup(this.chatId, position.lastAlertMessageId, { inline_keyboard: [] });
      } catch (error: unknown) {
        logger.warn({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to clear old alert buttons`);
      }
    }

    let messageText: string;
    let buttonList: PnlAlertButton[];

    if (type === 'profit') {
      const stopLossStatus: StopLossStatus = await this.verifyAndRestoreStopLoss(position);

      logger.info(
        { positionId: position.id, symbol: position.symbol, stopLossStatus, stopLossOrderId: position.stopLossOrderId, currentStopLossLevel: position.currentStopLossLevel },
        `[PnlMonitor] ${position.symbol} sendAlarmMessage verifyAndRestoreStopLoss result=${stopLossStatus} orderId=${position.stopLossOrderId ?? 'null'}`,
      );

      const lastPrice = this.getLastPriceFromKline(position.symbol);
      const pnlPercent = this.calculatePnlPercent(position, lastPrice);

      messageText = formatProfitAlertMessage({
        symbol: position.symbol,
        timeframe: position.timeframe,
        direction: position.direction,
        pnlPercent,
        entryPrice: position.entryPrice,
        lastPrice,
        maLevel: position.maLevel,
        isAugmented: position.isAugmented,
        stopLossLevel: position.currentStopLossLevel,
        stopLossStatus,
        stopLossOrderId: position.stopLossOrderId,
        stopLossErrorText: stopLossStatus === 'missing' ? position.stopLossLastErrorText : null,
      });

      buttonList = [
        { text: '✅ OK', callback_data: `pnl_ok:${positionId}` },
        { text: '💰 Close Position', callback_data: `pnl_close:${positionId}` },
      ];
    } else {
      const lastPrice = this.getLastPriceFromKline(position.symbol);
      const pnlPercent = this.calculatePnlPercent(position, lastPrice);
      const nextMaLevel = this.resolveNextMaLevel(position.maLevel);

      const isInsuranceLinked = position.insuranceChaserId !== null && position.insuranceFailReason !== null;
      const isInsuranceCreated = position.insuranceChaserId !== null && position.insuranceFailReason === null;

      messageText = formatLossAlertMessage({
        symbol: position.symbol,
        timeframe: position.timeframe,
        direction: position.direction,
        pnlPercent,
        entryPrice: position.entryPrice,
        lastPrice,
        maLevel: position.maLevel,
        isAugmented: position.isAugmented,
        isInsuranceCreated,
        isInsuranceLinked,
        insuranceMaLevel: nextMaLevel,
        insuranceFailReason: isInsuranceLinked ? null : position.insuranceFailReason,
      });

      buttonList = [{ text: '✅ OK', callback_data: `pnl_loss_ok:${positionId}` }];

      if (position.insuranceChaserId) {
        buttonList.push({ text: '❌ Cancel Insurance', callback_data: `pnl_cancel_ins:${positionId}` });
      }
    }

    try {
      const messageId = await this.sender.sendMessage({
        message: escapeMarkdownV2WithFormatting(messageText),
        peer: this.chatId,
        useMarkdownV2: true,
        returnMessageId: true,
        replyMarkup: { inline_keyboard: [buttonList] },
      });

      if (typeof messageId === 'number') {
        position.lastAlertMessageId = messageId;
      }
    } catch (error: unknown) {
      logger.warn({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to send alarm message`);
    }
  }

  private async buildPositionViewState(position: MonitoredPosition): Promise<PositionViewState> {
    const lastPrice = this.getLastPriceFromKline(position.symbol);
    const pnlPercent = this.calculatePnlPercent(position, lastPrice);
    const liquidationDistancePercent = calculatePercentChange(position.liquidationPrice, position.entryPrice);
    const isHalveMarkActive = position.isHalveAtBreakevenEnabled;
    const insuranceViewState = this.resolveInsuranceViewState(position);

    return {
      lastPrice,
      pnlPercent,
      liquidationDistancePercent,
      hasInsurance: insuranceViewState.hasInsurance,
      insuranceMaLevel: insuranceViewState.insuranceMaLevel,
      isInsuranceMissing: insuranceViewState.isInsuranceMissing,
      isHalveMarkActive,
    };
  }

  private toDisplayPrice(symbol: string, value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return value;
    }

    return Number(this.exchangeConnector.futures.priceToPrecision(symbol, value));
  }

  private async buildPositionItemList(): Promise<PositionListItem[]> {
    const positionItemList: PositionListItem[] = [];
    const breakevenHalfClosePercent = this.getPnlConfig().breakevenHalfClosePercent;

    for (const position of this.positionById.values()) {
      const viewState = await this.buildPositionViewState(position);
      const displayEntryPrice = this.toDisplayPrice(position.symbol, position.entryPrice);
      const displayLiquidationPrice = this.toDisplayPrice(position.symbol, position.liquidationPrice);

      positionItemList.push({
        symbol: position.symbol,
        direction: position.direction,
        entryPrice: displayEntryPrice,
        breakevenPrice: displayEntryPrice,
        volumeUsdt: position.volumeUsdt,
        leverage: position.leverage,
        contracts: position.contracts,
        plannedNotionalUsdt: position.plannedNotionalUsdt,
        liquidationPrice: displayLiquidationPrice,
        liquidationDistancePercent: viewState.liquidationDistancePercent,
        pnlPercent: viewState.pnlPercent,
        hasInsurance: viewState.hasInsurance,
        insuranceMaLevel: viewState.insuranceMaLevel,
        isInsuranceMissing: viewState.isInsuranceMissing,
        isHalveMarkActive: viewState.isHalveMarkActive,
        isAugmented: position.isAugmented,
        isImported: position.isImported,
        breakevenHalfClosePercent,
        isTrailingSlEnabled: position.isTrailingSlEnabled,
        isPnlAlertsEnabled: position.isPnlAlertsEnabled,
        isAutoCloseEnabled: position.isAutoCloseEnabled,
      });
    }

    return positionItemList;
  }

  private buildEphemeralItemList(): EphemeralPositionListItem[] {
    const ephemeralItemList: EphemeralPositionListItem[] = [];

    for (const snap of this.ephemeralPositionByKey.values()) {
      if (snap.direction === null) {
        continue;
      }

      const lastPrice = this.getLastPriceFromKline(snap.symbol) || snap.markPrice;
      const pnlPercent = lastPrice > 0 && snap.entryPrice > 0
        ? (snap.direction === 'long'
          ? calculatePercentChange(lastPrice, snap.entryPrice)
          : calculatePercentChange(snap.entryPrice, lastPrice))
        : 0;

      const displayLastPrice = lastPrice > 0 ? lastPrice : snap.markPrice;

      ephemeralItemList.push({
        symbol: snap.symbol,
        direction: snap.direction,
        entryPrice: this.toDisplayPrice(snap.symbol, snap.entryPrice),
        contracts: snap.contracts,
        leverage: snap.leverage,
        markPrice: this.toDisplayPrice(snap.symbol, displayLastPrice),
        pnlPercent,
        liquidationPrice: this.toDisplayPrice(snap.symbol, snap.liquidationPrice),
      });
    }

    return ephemeralItemList;
  }

  private async buildPositionDetail(position: MonitoredPosition): Promise<PositionDetailMessageArgs> {
    const viewState = await this.buildPositionViewState(position);
    const pnlUsdt = position.contracts * position.entryPrice * viewState.pnlPercent / 100;

    const marketDataManager = this.marketDataManagerByInterval.get(position.timeframe);
    const maValues = marketDataManager?.getMaValues(position.symbol) ?? { ma25: 0, ma50: 0, ma100: 0, ma200: 0 };

    const maValueList: MaValueWithOffset[] = MA_LEVEL_LIST.map((level) => {
      const rawPrice = getMaValue(maValues, level);
      const offsetFromLastPercent = viewState.lastPrice > 0 ? ((rawPrice - viewState.lastPrice) / viewState.lastPrice) * 100 : 0;
      const price = rawPrice > 0 ? Number(this.exchangeConnector.futures.priceToPrecision(position.symbol, rawPrice)) : rawPrice;

      return { level, price, offsetFromLastPercent };
    });

    const breakevenHalfClosePercent = this.getPnlConfig().breakevenHalfClosePercent;

    const displayEntryPrice = this.toDisplayPrice(position.symbol, position.entryPrice);
    const displayLastPrice = this.toDisplayPrice(position.symbol, viewState.lastPrice);
    const displayLiquidationPrice = this.toDisplayPrice(position.symbol, position.liquidationPrice);

    return {
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      maLevel: position.maLevel,
      contracts: position.contracts,
      entryPrice: displayEntryPrice,
      breakevenPrice: displayEntryPrice,
      lastPrice: displayLastPrice,
      liquidationPrice: displayLiquidationPrice,
      liquidationDistancePercent: viewState.liquidationDistancePercent,
      pnlPercent: viewState.pnlPercent,
      pnlUsdt,
      volumeUsdt: position.volumeUsdt,
      leverage: position.leverage,
      plannedNotionalUsdt: position.plannedNotionalUsdt,
      maValueList,
      hasInsurance: viewState.hasInsurance,
      insuranceMaLevel: viewState.insuranceMaLevel,
      isInsuranceMissing: viewState.isInsuranceMissing,
      isHalveMarkActive: viewState.isHalveMarkActive,
      isAugmented: position.isAugmented,
      isImported: position.isImported,
      breakevenHalfClosePercent,
      isTrailingSlEnabled: position.isTrailingSlEnabled,
      isPnlAlertsEnabled: position.isPnlAlertsEnabled,
      isAutoCloseEnabled: position.isAutoCloseEnabled,
    };
  }

  protected applyHalveEnableSnapshot(position: MonitoredPosition): void {
    const snapshot = this.captureEntryKlineSnapshot(position.symbol, position.timeframe);

    position.halveEnableKlineHighSnapshot = snapshot.high;
    position.halveEnableKlineLowSnapshot = snapshot.low;
    position.halveEnableKlineOpenTimestamp = this.computeKlineOpenTimestamp(position.timeframe, Date.now());
  }

  // Halve-specific decision PnL. On the candle where halve was enabled (manual SOS / insurance fill),
  // the favourable extreme is only honoured if price broke past the high/low snapshot captured at enable
  // time — so a pre-existing intra-candle high reached BEFORE the user pressed SOS does not trigger an
  // instant halve. On any other candle (or when no snapshot exists) it falls back to the regular
  // favourable extreme (which already carries the entry-kline guard).
  private computeHalveDecisionPnlPercent(position: MonitoredPosition, pnlPercent: number, favourableExtremePnlPercent: number): number {
    if (!position.isHalveAtBreakevenEnabled) {
      return favourableExtremePnlPercent;
    }

    const lastKline = this.getLatestKlineForTimeframe(position.symbol, position.timeframe);

    if (!lastKline) {
      return favourableExtremePnlPercent;
    }

    const isOnHalveEnableKline = position.halveEnableKlineOpenTimestamp !== null && lastKline.openTimestamp === position.halveEnableKlineOpenTimestamp;

    if (!isOnHalveEnableKline) {
      return favourableExtremePnlPercent;
    }

    const snapshot = position.direction === 'long' ? position.halveEnableKlineHighSnapshot : position.halveEnableKlineLowSnapshot;
    const guardedPrice = resolveGuardedExtremePrice({
      kline: lastKline,
      breakDirection: position.direction === 'long' ? 'above' : 'below',
      snapshot,
    });

    return guardedPrice === null ? pnlPercent : this.calculatePnlPercent(position, guardedPrice);
  }

  protected async runReactiveCheckers(position: MonitoredPosition, source: 'klineUpdatedTick' | 'klineClosed' | 'positionUpdate'): Promise<void> {
    if (this.isReactiveCheckBusyByPositionId.has(position.id)) {
      return;
    }

    if (this.consecutiveClosedPollTickCountByPositionId.has(position.id)) {
      return;
    }

    this.isReactiveCheckBusyByPositionId.add(position.id);

    try {
      const lastPrice = this.getLastPriceFromKline(position.symbol);

      if (lastPrice <= 0) {
        return;
      }

      const pnlPercent = this.calculatePnlPercent(position, lastPrice);
      const { favourable: favourableExtremePnlPercent, unfavourable: unfavourableExtremePnlPercent } = this.computeDecisionPnlPercents(position, pnlPercent, lastPrice);
      const halveDecisionPnlPercent = this.computeHalveDecisionPnlPercent(position, pnlPercent, favourableExtremePnlPercent);

      try {
        const isHalved = await this.checkBreakevenHalfClose(position, pnlPercent, lastPrice, halveDecisionPnlPercent);

        if (isHalved) {
          logger.info({ positionId: position.id, symbol: position.symbol, pnlPercent, halveDecisionPnlPercent, source }, `[PnlMonitor] ${position.symbol} Reactive checker halved position (source=${source}, decision pnl=${halveDecisionPnlPercent.toFixed(2)}%)`);

          return;
        }
      } catch (error: unknown) {
        logger.error({ error, positionId: position.id, symbol: position.symbol, source }, `[PnlMonitor] ${position.symbol} Reactive checkBreakevenHalfClose threw (source=${source})`);
      }

      try {
        const isAutoClosed = await this.checkAutoClose(position, pnlPercent, lastPrice, favourableExtremePnlPercent);

        if (isAutoClosed) {
          logger.info({ positionId: position.id, symbol: position.symbol, pnlPercent, favourableExtremePnlPercent, source }, `[PnlMonitor] ${position.symbol} Reactive checker auto-closed position (source=${source}, decision pnl=${favourableExtremePnlPercent.toFixed(2)}%)`);

          return;
        }
      } catch (error: unknown) {
        logger.error({ error, positionId: position.id, symbol: position.symbol, source }, `[PnlMonitor] ${position.symbol} Reactive checkAutoClose threw (source=${source})`);
      }

      try {
        this.checkProfitThreshold(position, pnlPercent);
      } catch (error: unknown) {
        logger.error({ error, positionId: position.id, symbol: position.symbol, source }, `[PnlMonitor] ${position.symbol} Reactive checkProfitThreshold threw (source=${source})`);
      }

      try {
        await this.checkLossThreshold(position, pnlPercent, unfavourableExtremePnlPercent);
      } catch (error: unknown) {
        logger.error({ error, positionId: position.id, symbol: position.symbol, source }, `[PnlMonitor] ${position.symbol} Reactive checkLossThreshold threw (source=${source})`);
      }
    } finally {
      this.isReactiveCheckBusyByPositionId.delete(position.id);
    }
  }

  private formatMaLine(position: MonitoredPosition, lastPrice: number): string {
    const marketDataManager = this.marketDataManagerByInterval.get(position.timeframe);

    if (!marketDataManager) {
      return `MA${position.maLevel}: n/a`;
    }

    const maValues = marketDataManager.getMaValues(position.symbol);

    if (!maValues) {
      return `MA${position.maLevel}: n/a`;
    }

    const maValue = getMaValue(maValues, position.maLevel);

    if (!Number.isFinite(maValue) || maValue <= 0) {
      return `MA${position.maLevel}: n/a`;
    }

    const preciseMaValue = this.exchangeConnector.futures.priceToPrecision(position.symbol, maValue);

    if (lastPrice <= 0) {
      return `MA${position.maLevel}: \`${preciseMaValue}\``;
    }

    const diffPercent = calculatePercentChange(lastPrice, maValue);
    const sign = diffPercent >= 0 ? '+' : '';

    return `MA${position.maLevel}: \`${preciseMaValue}\` (Last ${sign}${diffPercent.toFixed(2)}% from MA)`;
  }

  private resolveTpSplitContext(state: TpSplitState): TpSplitContext | null {
    if (state.ephemeralKey !== null) {
      const snap = this.ephemeralPositionByKey.get(state.ephemeralKey);

      if (!snap || snap.direction === null) {
        return null;
      }

      return {
        symbol: snap.symbol,
        direction: snap.direction,
        contracts: snap.contracts,
        entryPrice: snap.entryPrice,
        isEphemeral: true,
        position: null,
      };
    }

    if (state.positionId === null) {
      return null;
    }

    const position = this.positionById.get(state.positionId);

    if (!position) {
      return null;
    }

    return {
      symbol: position.symbol,
      direction: position.direction,
      contracts: position.contracts,
      entryPrice: position.entryPrice,
      isEphemeral: false,
      position,
    };
  }

  private async buildTpSplitHeader(context: TpSplitContext): Promise<string> {
    const headerText = context.isEphemeral || context.position === null
      ? this.buildEphemeralTpSplitHeader(context)
      : formatPositionDetailMessage(await this.buildPositionDetail(context.position));

    const state = this.tpSplitState;
    const tailLineList: string[] = [];

    if (state?.price1 !== null && state?.price1 !== undefined) {
      tailLineList.push(`First price: \`${state.price1}\``);
    }

    if (state?.parts !== null && state?.parts !== undefined) {
      const hasSizeContext = state.actualTpSize !== null && state.actualTpSize !== undefined && state.tpSize !== null && state.tpSize !== undefined;
      const sizeContext = hasSizeContext
        ? state.tpSize === state.actualTpSize
          ? ` × $${state.actualTpSize} each`
          : ` × $${state.actualTpSize} each (you requested $${state.tpSize})`
        : '';
      tailLineList.push(`Parts: ${state.parts}${sizeContext}`);
    }

    if (tailLineList.length === 0) {
      return headerText;
    }

    return `${headerText}\n\n${tailLineList.join('\n')}`;
  }

  private buildEphemeralTpSplitHeader(context: TpSplitContext): string {
    const lastPrice = this.getLastPriceFromKline(context.symbol);
    const pnlPercent = lastPrice > 0 && context.entryPrice > 0
      ? (context.direction === 'long'
        ? calculatePercentChange(lastPrice, context.entryPrice)
        : calculatePercentChange(context.entryPrice, lastPrice))
      : 0;
    const pnlSign = pnlPercent >= 0 ? '+' : '';

    const lineList: string[] = [
      `🌐 \`${context.symbol}\` ${context.direction.toUpperCase()} — Imported`,
      '',
      `Entry: \`${context.entryPrice}\``,
      `Last: \`${lastPrice > 0 ? lastPrice : context.entryPrice}\``,
      `Contracts: ${context.contracts}`,
      `PNL: ${pnlSign}${pnlPercent.toFixed(2)}%`,
    ];

    return lineList.join('\n');
  }

  protected async onPositionTeardown(position: MonitoredPosition | null): Promise<void> {
    if (position) {
      this.stopAlarm(position.id);
      this.profitAlarmThresholdByPositionId.delete(position.id);
    }
  }

  protected async onExternalCloseStart(position: MonitoredPosition): Promise<void> {
    this.stopAlarm(position.id);
  }

  protected onExternalMultiEntryCancel(position: MonitoredPosition, cancelType: string | undefined): void {
    this.bufferExternalMultiEntryCancel(position, cancelType);
  }

  protected async stripLastAlertKeyboard(position: MonitoredPosition, contextLabel: string): Promise<void> {
    if (position.lastAlertMessageId === null || !this.botInstance) {
      return;
    }

    try {
      await this.sender.editMessageReplyMarkup(this.chatId, position.lastAlertMessageId, { inline_keyboard: [] });
    } catch (error: unknown) {
      if (!isBenignTelegramEditError(error)) {
        logger.warn({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to strip last alert keyboard (${contextLabel})`);
      }
    }
  }

  private bufferExternalMultiEntryCancel(position: MonitoredPosition, cancelType: string | undefined): void {
    const existing = this.externalCancelBufferByPositionId.get(position.id);

    if (existing) {
      existing.cancelledCount += 1;

      if (cancelType) {
        existing.cancelType = cancelType;
      }
    } else {
      this.externalCancelBufferByPositionId.set(position.id, {
        symbol: position.symbol,
        timeframe: position.timeframe,
        direction: position.direction,
        maLevel: position.maLevel,
        isAugmented: position.isAugmented,
        cancelledCount: 1,
        cancelType,
      });
    }

    if (this.externalCancelFlushTimer === null) {
      this.externalCancelFlushTimer = setTimeout(() => {
        this.flushExternalMultiEntryCancels();
      }, EXTERNAL_CANCEL_FLUSH_DEBOUNCE_MS);
    }
  }

  private flushExternalMultiEntryCancels(): void {
    this.externalCancelFlushTimer = null;

    const bufferEntryList = [...this.externalCancelBufferByPositionId.entries()];
    this.externalCancelBufferByPositionId.clear();

    for (const [positionId, entry] of bufferEntryList) {
      const position = this.positionById.get(positionId);
      const remainingCount = position?.multiEntryOrderIdList?.length ?? 0;
      const message = formatExternalMultiEntryCancelMessage({
        symbol: entry.symbol,
        timeframe: entry.timeframe,
        direction: entry.direction,
        maLevel: entry.maLevel,
        isAugmented: entry.isAugmented,
        cancelledCount: entry.cancelledCount,
        remainingCount,
        cancelType: entry.cancelType,
      });

      logger.warn(
        { positionId, symbol: entry.symbol, cancelledCount: entry.cancelledCount, remainingCount, cancelType: entry.cancelType, timeframe: entry.timeframe },
        `[PnlMonitor] ${entry.symbol} ${entry.cancelledCount} multi-entry order(s) cancelled externally (cancelType=${entry.cancelType ?? 'n/a'}), remaining=${remainingCount} [${entry.timeframe}]`,
      );

      this.sendMessage(message).catch((error: unknown) => {
        logger.warn({ error, symbol: entry.symbol }, `[PnlMonitor] ${entry.symbol} Failed to send external multi-entry cancel notification`);
      });
    }
  }

  protected formatMaLabel(maLevel: MaLevel): string {
    return `MA${maLevel}`;
  }

  private buildToggleStatusLabel(isOn: boolean): string {
    return isOn ? `ON ${EMOJI_CHECK}` : `OFF ${EMOJI_CROSS}`;
  }

  protected async sendMessage(message: string): Promise<number | null> {
    try {
      const messageId = await this.sender.sendMessage({
        message: escapeMarkdownV2WithFormatting(message),
        peer: this.chatId,
        useMarkdownV2: true,
        returnMessageId: true,
      });

      return typeof messageId === 'number' ? messageId : null;
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] Failed to send message');

      return null;
    }
  }

  private async deleteTrackedMessages(): Promise<void> {
    await this.menuReplacer.deleteTrackedMessages(null);
  }

  private async replaceMenu(ctx: Context | null, args: ReplaceMenuArgs): Promise<number | null> {
    return this.menuReplacer.replaceMenu(ctx, args);
  }

  private async deleteUserMessage(ctx: Context): Promise<void> {
    try {
      const messageId = (ctx.message as { message_id?: number } | undefined)?.message_id;

      if (messageId) {
        await this.sender.deleteMessage(this.chatId, messageId);
      }
    } catch (error: unknown) {
      logger.warn({ error, chatId: this.chatId }, '[PnlMonitor] Failed to delete user message');
    }
  }

  private async sendPositionsListReply(ctx: Context): Promise<void> {
    this.tpSplitState = null;

    await this.showLoadingPlaceholder(ctx);
    await this.scanExchangePositions();
    await this.renderPositionsList(ctx);
  }

  private async showLoadingPlaceholder(ctx: PositionsReplyContext): Promise<void> {
    await this.deleteTrackedMessages();

    try {
      const sent = await ctx.reply(LOADING_TEXT, {}) as { message_id?: number };

      if (sent.message_id) {
        this.messageTracker.set(this.chatId, [sent.message_id]);
      }
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] Failed to send loading placeholder');
    }
  }

  private async renderPositionsList(ctx: Context | null): Promise<void> {
    try {
      const trackedItemList = await this.buildPositionItemList();
      const ephemeralItemList = this.buildEphemeralItemList();
      const exchangeLabel = formatExchangeLabel(this.exchangeConnector.getExchangeName());
      const message = formatPositionsListMessage({ exchangeLabel, trackedList: trackedItemList, ephemeralList: ephemeralItemList });

      const buttonRowList: PnlAlertButton[][] = [];

      for (const position of this.positionById.values()) {
        const directionDot = position.direction === 'long' ? EMOJI_LONG_DOT : EMOJI_SHORT_DOT;
        const importedSuffix = position.isImported ? ' [imp]' : '';

        buttonRowList.push([{
          text: `${directionDot} ${position.symbol}${importedSuffix}`,
          callback_data: `pnl_position_detail:${position.id}`,
        }]);
      }

      for (const ephemeral of this.ephemeralPositionByKey.values()) {
        if (ephemeral.direction === null) {
          continue;
        }

        const directionDot = ephemeral.direction === 'long' ? EMOJI_LONG_DOT : EMOJI_SHORT_DOT;

        buttonRowList.push([{
          text: `${directionDot} ${ephemeral.symbol} (imp)`,
          callback_data: `pnl_eph_detail:${ephemeral.symbol}:${ephemeral.direction}`,
        }]);
      }

      buttonRowList.push([{ text: `${EMOJI_CROSS} Close`, callback_data: 'pnl_positions_close' }]);

      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
        replyMarkup: { inline_keyboard: buttonRowList },
      });
    } catch (error: unknown) {
      logger.error({ error }, '[PnlMonitor] Failed to show positions');
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to load positions`),
      });
    }
  }

  private async startCallbackLoading(ctx: Context, mode: LoadingMode, loadingText: string = LOADING_TEXT): Promise<LoadingHandle> {
    return this.loadingController.startCallbackLoading(ctx, mode, loadingText);
  }

  private registerCallbackHandlers(bot: Telegraf): void {
    bot.use(async (ctx, next) => {
      const incomingChatId = ctx.chat?.id?.toString();

      if (incomingChatId !== this.chatId) {
        return;
      }

      if (ctx.message) {
        await this.deleteUserMessage(ctx);
      }

      return next();
    });

    bot.command('menu', async (ctx) => {
      await this.deleteTrackedMessages();
      await ctx.reply(escapeMarkdownV2WithFormatting('PNL Monitor'), {
        parse_mode: 'MarkdownV2',
        reply_markup: PNL_REPLY_KEYBOARD,
      });
    });

    bot.hears(PNL_MENU_BUTTON_POSITIONS, async (ctx) => {
      await this.sendPositionsListReply(ctx);
    });

    bot.hears(PNL_MENU_BUTTON_CLOSE, async (ctx) => {
      this.tpSplitState = null;
      await this.deleteTrackedMessages();
      await ctx.reply('Menu closed', { reply_markup: { remove_keyboard: true } });
    });

    bot.action(/^pnl_ok:(.+)/, (ctx) => this.handleProfitAck(ctx as ContextWithMatch));

    bot.action(/^pnl_close:(.+)/, async (ctx) => {
      const positionId = ctx.match[1];
      await this.startCallbackLoading(ctx, 'strip-keyboard');

      this.stopAlarm(positionId);

      const position = this.positionById.get(positionId);

      if (!position) {
        await this.replaceMenu(ctx, {
          text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} Position already closed`),
        });

        return;
      }

      try {
        await this.closePosition(position);
        await this.removePosition(positionId);

        const message = formatPositionClosedMessage({
          symbol: position.symbol,
          timeframe: position.timeframe,
          direction: position.direction,
          maLevel: position.maLevel,
          entryPrice: position.entryPrice,
          isAugmented: position.isAugmented,
        });

        await this.replaceMenu(ctx, {
          text: escapeMarkdownV2WithFormatting(message),
        });
        logger.info({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Position closed by user`);
      } catch (error: unknown) {
        logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to close position`);
        await this.replaceMenu(ctx, {
          text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to close ${position.symbol}`),
        });
      }
    });

    bot.action(/^pnl_loss_ok:(.+)/, async (ctx) => {
      const positionId = ctx.match[1];
      await ctx.answerCbQuery();
      // Terminal acknowledge: strip keyboard only, no menu change. Loss alerts are push notifications
      // (not part of any navigation tracker), so we keep the message body and only remove buttons.
      await ctx.editMessageReplyMarkup(undefined);

      this.stopAlarm(positionId);

      const position = this.positionById.get(positionId);

      if (!position) {
        return;
      }

      position.isLossAlertAcknowledged = true;
      position.lastAlertMessageId = null;

      await this.safeUpdateMonitoredPosition(positionId, {
        isLossAlertAcknowledged: true,
        lastAlertMessageId: null,
      });

      logger.info({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Loss alert acknowledged`);
    });

    this.registerInsuranceCallbackHandlers(bot);

    bot.action(/^tp_split:(.+)/, (ctx) => this.handleTpSplitStart(ctx));
    bot.action(/^tp_size:(.+)/, (ctx) => this.handleTpSplitTpSize(ctx));
    bot.action('tp_split_confirm', (ctx) => this.handleTpSplitConfirm(ctx));
    bot.action('tp_split_cancel', (ctx) => this.handleTpSplitCancel(ctx));
    bot.action('pnl_positions_close', (ctx) => this.handlePositionsClose(ctx));
    bot.action(/^pnl_position_detail:(.+)/, (ctx) => this.handlePositionDetail(ctx as ContextWithMatch));
    bot.action(/^pnl_eph_detail:([^:]+):(long|short)$/, (ctx) => this.handleEphemeralPositionDetail(ctx as ContextWithMatch));
    bot.action(/^pnl_eph_tp:([^:]+):(long|short)$/, (ctx) => this.handleEphemeralTpSplitStart(ctx as ContextWithMatch));
    bot.action(/^pnl_eph_track:([^:]+):(long|short)$/, (ctx) => this.handleTrackImported(ctx as ContextWithMatch));
    bot.action('pnl_positions_back', (ctx) => this.handlePositionsBack(ctx));
    bot.action(/^pnl_sos:(.+)/, (ctx) => this.handlePnlSos(ctx as ContextWithMatch));
    bot.action(/^pnl_cancel_sos:(.+)/, (ctx) => this.handleCancelSos(ctx as ContextWithMatch));
    bot.action(/^pnl_cancel_tp:(.+)/, (ctx) => this.handleCancelAllTp(ctx as ContextWithMatch));
    bot.action(/^pnl_cancel_multi_entries:(.+)/, (ctx) => this.handleCancelPendingMultiEntries(ctx as ContextWithMatch));
    bot.action(/^pnl_auto_tp:(.+)/, (ctx) => this.handleAutoTpMenu(ctx as ContextWithMatch));
    bot.action(/^pnl_auto_tp_back:(.+)/, (ctx) => this.handleAutoTpBack(ctx as ContextWithMatch));
    bot.action(/^pnl_toggle_trailing_sl:(.+)/, (ctx) => this.handleToggleTrailingSl(ctx as ContextWithMatch));
    bot.action(/^pnl_toggle_alerts:(.+)/, (ctx) => this.handleTogglePnlAlerts(ctx as ContextWithMatch));
    bot.action(/^pnl_toggle_auto_close:(.+)/, (ctx) => this.handleToggleAutoClose(ctx as ContextWithMatch));
    bot.on('text', (ctx) => this.handleTpSplitTextInput(ctx));
  }

  private async handlePositionsClose(ctx: Context): Promise<void> {
    try {
      await ctx.answerCbQuery();
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handlePositionsClose');
    }

    await this.replaceMenu(ctx, { shouldCloseOnly: true });
  }

  private async handlePositionDetail(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    this.tpSplitState = null;
    await this.renderPositionDetail(ctx, position);
  }

  private async handleEphemeralPositionDetail(ctx: ContextWithMatch): Promise<void> {
    const symbol = ctx.match[1];
    const direction = ctx.match[2] as 'long' | 'short';
    const key = `${symbol}:${direction}`;
    await this.startCallbackLoading(ctx, 'strip-keyboard');

    const snap = this.ephemeralPositionByKey.get(key);

    if (!snap || snap.direction === null) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Imported position no longer in last scan — refresh list`),
      });

      return;
    }

    this.tpSplitState = null;
    await this.renderEphemeralPositionDetail(ctx, snap, direction);
  }

  private async handleTrackImported(ctx: ContextWithMatch): Promise<void> {
    const symbol = ctx.match[1];
    const direction = ctx.match[2] as 'long' | 'short';
    const key = `${symbol}:${direction}`;
    const loading = await this.startCallbackLoading(ctx, 'replace-text');

    const existingPosition = this.findActivePositionByKey(symbol, direction);

    if (existingPosition) {
      await loading.finalize(escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} ${symbol} ${direction} already tracked`));

      return;
    }

    const snap = this.ephemeralPositionByKey.get(key);

    if (!snap || snap.direction === null) {
      await loading.fail(escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Imported position no longer in last scan — refresh list`));

      return;
    }

    const position = this.buildImportedPosition(snap, direction);

    if (this.findActivePositionByKey(symbol, direction)) {
      await loading.finalize(escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} ${symbol} ${direction} already tracked (race)`));

      return;
    }

    this.positionById.set(position.id, position);

    try {
      await this.positionStore.saveMonitoredPosition(position);
    } catch (error: unknown) {
      this.positionById.delete(position.id);
      logger.error({ error, symbol, direction }, `[PnlMonitor] ${symbol} Failed to persist imported position`);
      await loading.fail(escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to persist imported position`));

      return;
    }

    this.ephemeralPositionByKey.delete(key);

    logger.info(
      { positionId: position.id, symbol, direction, contracts: snap.contracts, entryPrice: snap.entryPrice },
      `[PnlMonitor] ${symbol} Imported position tracked (id=${position.id}, contracts=${snap.contracts}, entryPrice=${snap.entryPrice})`,
    );

    await loading.clear();
    await this.scanExchangePositions();
    await this.renderPositionsList(ctx);
  }

  private async renderEphemeralPositionDetail(ctx: Context | null, snap: Position, direction: 'long' | 'short'): Promise<void> {
    try {
      const lastPrice = this.getLastPriceFromKline(snap.symbol) || snap.markPrice;
      const pnlPercent = lastPrice > 0 && snap.entryPrice > 0
        ? (direction === 'long'
          ? calculatePercentChange(lastPrice, snap.entryPrice)
          : calculatePercentChange(snap.entryPrice, lastPrice))
        : 0;
      const pnlUsdt = snap.contracts * snap.entryPrice * pnlPercent / 100;

      const displayLastPrice = lastPrice > 0 ? lastPrice : snap.markPrice;
      const message = formatEphemeralPositionDetailMessage({
        symbol: snap.symbol,
        direction,
        contracts: snap.contracts,
        entryPrice: this.toDisplayPrice(snap.symbol, snap.entryPrice),
        lastPrice: this.toDisplayPrice(snap.symbol, displayLastPrice),
        liquidationPrice: this.toDisplayPrice(snap.symbol, snap.liquidationPrice),
        leverage: snap.leverage,
        pnlPercent,
        pnlUsdt,
      });

      const buttonRowList: PnlAlertButton[][] = [
        [
          { text: `${EMOJI_PROFIT} TP`, callback_data: `pnl_eph_tp:${snap.symbol}:${direction}` },
          { text: `${EMOJI_TARGET} Track`, callback_data: `pnl_eph_track:${snap.symbol}:${direction}` },
        ],
        [{ text: '← Back', callback_data: 'pnl_positions_back' }],
      ];

      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
        replyMarkup: { inline_keyboard: buttonRowList },
      });
    } catch (error: unknown) {
      logger.error({ error, symbol: snap.symbol }, `[PnlMonitor] ${snap.symbol} Failed to render ephemeral position detail`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to load imported position`),
      });
    }
  }

  private async renderPositionDetail(ctx: Context | null, position: MonitoredPosition): Promise<void> {
    try {
      const detail = await this.buildPositionDetail(position);
      const message = formatPositionDetailMessage(detail);

      const actionButtonRow: PnlAlertButton[] = [
        { text: `${EMOJI_ROBOT} Auto TP`, callback_data: `pnl_auto_tp:${position.id}` },
        { text: `${EMOJI_PROFIT} TP`, callback_data: `tp_split:${position.id}` },
      ];

      if (this.isSosActive(position)) {
        actionButtonRow.push({ text: `${EMOJI_DOOR} Cancel SOS`, callback_data: `pnl_cancel_sos:${position.id}` });
      } else {
        actionButtonRow.push({ text: `${EMOJI_SOS} SOS`, callback_data: `pnl_sos:${position.id}` });
      }

      const buttonRowList: PnlAlertButton[][] = [actionButtonRow];

      if (position.tpOrderIdList && position.tpOrderIdList.length > 0) {
        buttonRowList.push([
          { text: `${EMOJI_CROSS} Cancel all TP (${position.tpOrderIdList.length})`, callback_data: `pnl_cancel_tp:${position.id}` },
        ]);
      }

      if (position.multiEntryOrderIdList && position.multiEntryOrderIdList.length > 0) {
        buttonRowList.push([
          { text: `${EMOJI_CROSS} Cancel pending entries (${position.multiEntryOrderIdList.length})`, callback_data: `pnl_cancel_multi_entries:${position.id}` },
        ]);
      }

      buttonRowList.push([{ text: '← Back', callback_data: 'pnl_positions_back' }]);

      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
        replyMarkup: { inline_keyboard: buttonRowList },
      });
    } catch (error: unknown) {
      logger.error({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to render position detail`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to load position detail`),
      });
    }
  }

  private async renderAutoTpMenu(ctx: Context | null, position: MonitoredPosition): Promise<void> {
    try {
      const message = formatAutoTpMenuMessage({
        symbol: position.symbol,
        direction: position.direction,
        isTrailingSlEnabled: position.isTrailingSlEnabled,
        isPnlAlertsEnabled: position.isPnlAlertsEnabled,
        isAutoCloseEnabled: position.isAutoCloseEnabled,
      });

      const trailingLabel = `${EMOJI_SETTINGS} Trailing SL: ${this.buildToggleStatusLabel(position.isTrailingSlEnabled)}`;
      const alertsLabel = `${EMOJI_SETTINGS} PnL alerts: ${this.buildToggleStatusLabel(position.isPnlAlertsEnabled)}`;
      const autoCloseLabel = `${EMOJI_SETTINGS} Auto-close: ${this.buildToggleStatusLabel(position.isAutoCloseEnabled)}`;

      const buttonRowList: PnlAlertButton[][] = [
        [{ text: trailingLabel, callback_data: `pnl_toggle_trailing_sl:${position.id}` }],
        [{ text: alertsLabel, callback_data: `pnl_toggle_alerts:${position.id}` }],
        [{ text: autoCloseLabel, callback_data: `pnl_toggle_auto_close:${position.id}` }],
        [{ text: '← Back', callback_data: `pnl_auto_tp_back:${position.id}` }],
      ];

      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
        replyMarkup: { inline_keyboard: buttonRowList },
      });
    } catch (error: unknown) {
      logger.error({ error, positionId: position.id, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to render Auto TP menu`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to render Auto TP menu`),
      });
    }
  }

  private async handleAutoTpMenu(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    this.tpSplitState = null;
    await this.renderAutoTpMenu(ctx, position);
  }

  private async handleAutoTpBack(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    await this.renderPositionDetail(ctx, position);
  }

  private async handleToggleTrailingSl(ctx: ContextWithMatch): Promise<void> {
    await this.handleAutoTpToggle(ctx, 'isTrailingSlEnabled', { shouldStopAlarmWhenDisabled: false });
  }

  private async handleTogglePnlAlerts(ctx: ContextWithMatch): Promise<void> {
    await this.handleAutoTpToggle(ctx, 'isPnlAlertsEnabled', { shouldStopAlarmWhenDisabled: true });
  }

  private async handleToggleAutoClose(ctx: ContextWithMatch): Promise<void> {
    await this.handleAutoTpToggle(ctx, 'isAutoCloseEnabled', { shouldStopAlarmWhenDisabled: false });
  }

  private async handleAutoTpToggle(ctx: ContextWithMatch, fieldName: MonitoringFlagFieldName, options: AutoTpToggleOptions): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    const newValue = !position[fieldName];
    position[fieldName] = newValue;

    if (options.shouldStopAlarmWhenDisabled && newValue === false) {
      this.stopAlarm(positionId);
    }

    try {
      await this.safeUpdateMonitoredPosition(positionId, { [fieldName]: newValue } as Partial<MonitoredPosition>);
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol, fieldName, newValue }, `[PnlMonitor] ${position.symbol} Failed to persist ${fieldName}=${newValue}`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to persist ${fieldName}`),
      });

      return;
    }

    logger.info(
      { positionId, symbol: position.symbol, fieldName, newValue, timeframe: position.timeframe },
      `[PnlMonitor] ${position.symbol} Auto TP toggle: ${fieldName}=${newValue} [${position.timeframe}]`,
    );

    await this.renderAutoTpMenu(ctx, position);
  }

  private async handlePositionsBack(ctx: Context): Promise<void> {
    await this.startCallbackLoading(ctx, 'strip-keyboard');

    this.tpSplitState = null;

    await this.scanExchangePositions();
    await this.renderPositionsList(ctx);
  }

  /**
   * Unified "SOS active" predicate. Auto-SOS (insurance order created on loss) and manual SOS (halve
   * flag) are one and the same SOS state. Returns true while the halve flag is armed OR a live
   * insurance chaser is still pending (not yet filled). A filled insurance chaser is deleted, leaving
   * only the sticky `insuranceChaserId` reference — that reference must NOT count as active SOS, hence
   * the `getChaser` liveness check rather than a bare `insuranceChaserId !== null`.
   */
  protected isSosActive(position: MonitoredPosition): boolean {
    if (position.isHalveAtBreakevenEnabled) {
      return true;
    }

    return this.resolveInsuranceViewState(position).hasInsurance;
  }

  private async handleProfitAck(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');

    this.stopAlarm(positionId);

    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} Position already closed`),
      });

      return;
    }

    try {
      const step = this.getPnlConfig().profitThresholdPercent;
      const lastPrice = this.getLastPriceFromKline(position.symbol);
      const pnlPercent = this.calculatePnlPercent(position, lastPrice);
      const currentThreshold = Math.floor(pnlPercent / step) * step;
      const armedThreshold = this.profitAlarmThresholdByPositionId.get(positionId) ?? 0;
      const ackThreshold = Math.max(currentThreshold, armedThreshold, position.lastAcknowledgedThreshold);

      position.lastAcknowledgedThreshold = ackThreshold;
      position.isUserResponded = true;
      position.lastAlertMessageId = null;
      position.isTrailingSlEnabled = false;
      position.isAutoCloseEnabled = false;
      this.profitAlarmThresholdByPositionId.delete(positionId);

      await this.safeUpdateMonitoredPosition(positionId, {
        lastAcknowledgedThreshold: ackThreshold,
        isUserResponded: true,
        lastAlertMessageId: null,
        isTrailingSlEnabled: false,
        isAutoCloseEnabled: false,
      });

      logger.info({ positionId, symbol: position.symbol, acknowledgedThreshold: ackThreshold }, `[PnlMonitor] ${position.symbol} Profit alert acknowledged at ${ackThreshold}% — trailing SL + auto-close disabled (user takes over)`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} ${position.symbol} acknowledged at ${ackThreshold}% — trailing SL + auto-close OFF`),
      });
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to acknowledge profit alert`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to acknowledge ${position.symbol}`),
      });
    }
  }

  private async handlePnlSos(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    if (this.isSosActive(position)) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} ${position.symbol} is already in SOS mode`),
      });

      return;
    }

    try {
      const message = await this.markPositionAsSos(position);
      // Terminal SOS-mark message — sent via replaceMenu without inline keyboard so the message lingers
      // as a chat record (not tracked for deletion on next navigation).
      const sentMessageId = await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
      });

      if (sentMessageId !== null) {
        this.messageTracker.delete(this.chatId);
      }
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to mark position as SOS`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to mark ${position.symbol} as SOS`),
      });
    }
  }

  private async handleCancelSos(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    if (!this.isSosActive(position)) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} SOS is not active`),
      });

      return;
    }

    position.isHalveAtBreakevenEnabled = false;
    position.lastAcknowledgedThreshold = 0;
    this.profitAlarmThresholdByPositionId.delete(position.id);
    position.isLossAlertAcknowledged = false;
    position.isUserResponded = false;
    position.isAutoCloseNotified = false;
    position.lastAlertMessageId = null;
    position.halveEnableKlineHighSnapshot = null;
    position.halveEnableKlineLowSnapshot = null;
    position.halveEnableKlineOpenTimestamp = null;

    const persistPayload: Partial<MonitoredPosition> = {
      isHalveAtBreakevenEnabled: false,
      lastAcknowledgedThreshold: 0,
      isLossAlertAcknowledged: false,
      isUserResponded: false,
      isAutoCloseNotified: false,
      lastAlertMessageId: null,
      halveEnableKlineHighSnapshot: null,
      halveEnableKlineLowSnapshot: null,
      halveEnableKlineOpenTimestamp: null,
    };

    // Cancel any pending insurance chaser (auto-SOS still unfilled). For manual SOS (no insurance) or
    // post-fill SOS (chaser already gone) the hook returns null → the legacy behaviour (disable halve
    // only, contracts stay in the position) is preserved.
    const { cancelledInsuranceMaLevel } = await this.onCancelSos(position);

    if (cancelledInsuranceMaLevel !== null) {
      persistPayload.insuranceChaserId = null;
      persistPayload.hasInsuranceCycleCompleted = true;
    }

    this.stopAlarm(positionId);

    try {
      await this.safeUpdateMonitoredPosition(positionId, persistPayload);
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to persist Cancel SOS`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to cancel SOS for ${position.symbol}`),
      });

      return;
    }

    logger.info(
      { positionId, symbol: position.symbol, cancelledInsuranceMaLevel, timeframe: position.timeframe },
      `[PnlMonitor] ${position.symbol} SOS cancelled by user — halve-at-breakeven disabled${cancelledInsuranceMaLevel !== null ? `, pending insurance chaser cancelled (MA${cancelledInsuranceMaLevel}), auto-insurance locked` : ''} [${position.timeframe}]`,
    );

    const message = formatSosCancelledMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      maLevel: position.maLevel,
      isAugmented: position.isAugmented,
      cancelledInsuranceMaLevel,
    });

    // Terminal Cancel-SOS message — sent via replaceMenu without inline keyboard so the message lingers
    // as a chat record (not tracked for deletion on next navigation).
    const sentMessageId = await this.replaceMenu(ctx, {
      text: escapeMarkdownV2WithFormatting(message),
    });

    if (sentMessageId !== null) {
      this.messageTracker.delete(this.chatId);
    }
  }

  private async handleCancelAllTp(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    if (position.tpOrderIdList === null || position.tpOrderIdList.length === 0) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} No TP orders to cancel`),
      });

      return;
    }

    this.tpSplitState = null;

    let outcome: { cancelledCount: number; failedCount: number };

    try {
      outcome = await this.cancelAllTpOrders(positionId);
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to cancel TP orders`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to cancel TP orders for ${position.symbol}`),
      });

      return;
    }

    const message = formatTpCancelledMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      maLevel: position.maLevel,
      isAugmented: position.isAugmented,
      cancelledCount: outcome.cancelledCount,
      failedCount: outcome.failedCount,
    });

    const sentMessageId = await this.replaceMenu(ctx, {
      text: escapeMarkdownV2WithFormatting(message),
    });

    if (sentMessageId !== null) {
      this.messageTracker.delete(this.chatId);
    }
  }

  private async handleCancelPendingMultiEntries(ctx: ContextWithMatch): Promise<void> {
    const positionId = ctx.match[1];
    await this.startCallbackLoading(ctx, 'strip-keyboard');
    const position = this.positionById.get(positionId);

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    if (position.multiEntryOrderIdList === null || position.multiEntryOrderIdList.length === 0) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CHECK} No pending entry orders to cancel`),
      });

      return;
    }

    this.tpSplitState = null;

    let outcome: { cancelledCount: number };

    try {
      outcome = await this.cancelPendingMultiEntries(positionId);
    } catch (error: unknown) {
      logger.error({ error, positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Failed to cancel pending multi-entry orders`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to cancel pending entries for ${position.symbol}`),
      });

      return;
    }

    const message = formatPendingEntriesCancelledMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      maLevel: position.maLevel,
      isAugmented: position.isAugmented,
      cancelledCount: outcome.cancelledCount,
    });

    const sentMessageId = await this.replaceMenu(ctx, {
      text: escapeMarkdownV2WithFormatting(message),
    });

    if (sentMessageId !== null) {
      this.messageTracker.delete(this.chatId);
    }
  }

  private async markPositionAsSos(position: MonitoredPosition): Promise<string> {
    // Snapshot the current kline high/low BEFORE flipping the flag (synchronous block, no await between),
    // so a reactive checker that observes isHalveAtBreakevenEnabled=true never sees a stale/empty snapshot.
    // This makes halve wait for a NEW breakeven touch after enabling, instead of firing on the candle's
    // pre-existing intra-candle high reached before the user pressed SOS.
    this.applyHalveEnableSnapshot(position);

    position.isHalveAtBreakevenEnabled = true;
    position.lastAcknowledgedThreshold = 0;
    this.profitAlarmThresholdByPositionId.delete(position.id);
    position.isLossAlertAcknowledged = false;
    position.isUserResponded = false;
    position.isAutoCloseNotified = false;

    await this.safeUpdateMonitoredPosition(position.id, {
      halveEnableKlineHighSnapshot: position.halveEnableKlineHighSnapshot,
      halveEnableKlineLowSnapshot: position.halveEnableKlineLowSnapshot,
      halveEnableKlineOpenTimestamp: position.halveEnableKlineOpenTimestamp,
      isHalveAtBreakevenEnabled: true,
      lastAcknowledgedThreshold: 0,
      isLossAlertAcknowledged: false,
      isUserResponded: false,
      isAutoCloseNotified: false,
    });

    this.stopAlarm(position.id);

    const settings = { pnlMonitor: this.getPnlConfig() };
    const breakevenHalfClosePercent = settings.pnlMonitor.breakevenHalfClosePercent;
    const breakevenPriceRaw = calculateBreakevenPrice(position.entryPrice, position.direction, breakevenHalfClosePercent);
    const breakevenPrice = Number(this.exchangeConnector.futures.priceToPrecision(position.symbol, breakevenPriceRaw));
    const lastPrice = this.getLastPriceFromKline(position.symbol);
    const pnlPercent = this.calculatePnlPercent(position, lastPrice);

    logger.info(
      { positionId: position.id, symbol: position.symbol, entryPrice: position.entryPrice, breakevenPrice, contracts: position.contracts, breakevenHalfClosePercent, timeframe: position.timeframe },
      `[PnlMonitor] ${position.symbol} Manual SOS marked — halve-at-breakeven enabled (entry=${position.entryPrice}, breakeven=${breakevenPrice}, halve threshold=+${breakevenHalfClosePercent}%) [${position.timeframe}]`,
    );

    return formatSosMarkedMessage({
      symbol: position.symbol,
      timeframe: position.timeframe,
      direction: position.direction,
      maLevel: position.maLevel,
      entryPrice: position.entryPrice,
      breakevenPrice,
      lastPrice,
      pnlPercent,
      contracts: position.contracts,
      breakevenHalfClosePercent,
      isAugmented: position.isAugmented,
    });
  }

  private async handleTpSplitStart(ctx: Context): Promise<void> {
    const { match } = ctx as ContextWithMatch;
    const positionId = match[1];
    const position = this.positionById.get(positionId);

    try {
      await ctx.answerCbQuery();
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleTpSplitStart');
    }

    if (!position) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Position not found`),
      });

      return;
    }

    this.tpSplitState = {
      positionId,
      ephemeralKey: null,
      step: 'price1',
      messageId: 0,
      price1: null,
      tpSize: null,
      actualTpSize: null,
      parts: null,
      parsedMode: null,
      plan: null,
    };

    logger.info({ positionId, symbol: position.symbol }, `[PnlMonitor] ${position.symbol} Split TP dialog started`);
    const context: TpSplitContext = {
      symbol: position.symbol,
      direction: position.direction,
      contracts: position.contracts,
      entryPrice: position.entryPrice,
      isEphemeral: false,
      position,
    };
    await this.editTpSplitPrompt(ctx, context);
  }

  private async handleEphemeralTpSplitStart(ctx: ContextWithMatch): Promise<void> {
    const symbol = ctx.match[1];
    const direction = ctx.match[2] as 'long' | 'short';
    const key = `${symbol}:${direction}`;

    try {
      await ctx.answerCbQuery();
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleEphemeralTpSplitStart');
    }

    const snap = this.ephemeralPositionByKey.get(key);

    if (!snap || snap.direction === null) {
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Imported position no longer in last scan — refresh list`),
      });

      return;
    }

    this.tpSplitState = {
      positionId: null,
      ephemeralKey: key,
      step: 'price1',
      messageId: 0,
      price1: null,
      tpSize: null,
      actualTpSize: null,
      parts: null,
      parsedMode: null,
      plan: null,
    };

    logger.info({ symbol, direction, contracts: snap.contracts, entryPrice: snap.entryPrice }, `[PnlMonitor] ${symbol} Ephemeral Split TP dialog started`);
    await this.editTpSplitPromptForEphemeral(ctx, snap, direction);
  }

  private async handleTpSplitTpSize(ctx: Context): Promise<void> {
    const state = this.tpSplitState;

    try {
      await ctx.answerCbQuery();
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleTpSplitTpSize');
    }

    if (!state || state.step !== 'tpSize') {
      return;
    }

    const context = this.resolveTpSplitContext(state);

    if (!context) {
      this.tpSplitState = null;

      return;
    }

    const { match } = ctx as ContextWithMatch;
    const parsed = parseOrderSizeInput({ text: match[1], minValue: 1 });

    if (!parsed.isValid) {
      await this.editTpSplitTpSize(ctx, context, parsed.error);

      return;
    }

    this.applyTpSizeToState(state, context, parsed.orderSize);
    state.step = 'mode';
    await this.editTpSplitMode(ctx, context);
  }

  private applyTpSizeToState(state: TpSplitState, context: TpSplitContext, requestedTpSize: number): void {
    const totalPositionNotional = context.contracts * context.entryPrice;
    const { count: tpCount, actualSize: actualTpSize } = deriveOrderPlan({
      totalNotional: totalPositionNotional,
      requestedSize: requestedTpSize,
      minCount: 2,
    });

    state.tpSize = requestedTpSize;
    state.actualTpSize = actualTpSize;
    state.parts = tpCount;

    logger.info(
      { positionId: context.position?.id ?? null, symbol: context.symbol, isEphemeral: context.isEphemeral, requestedTpSize, tpCount, actualTpSize, totalPositionNotional },
      `[PnlMonitor] ${context.symbol} TP size derive: requested $${requestedTpSize} → ${tpCount} × $${actualTpSize}`,
    );
  }

  private async computeTpSplitPlan(
    context: TpSplitContext,
    state: TpSplitState,
    parsedMode: TpSplitParsedMode,
  ): Promise<{ isValid: true; plan: TpSplitPlanPart[] } | { isValid: false; error: string }> {
    if (state.price1 === null || state.parts === null) {
      return { isValid: false, error: 'Internal state incomplete' };
    }

    const tradeSymbol = this.exchangeConnector.futures.tradeSymbols.get(context.symbol);

    if (!tradeSymbol) {
      return { isValid: false, error: `Unknown symbol ${context.symbol}` };
    }

    const priceBuild = buildPriceList({
      price1: state.price1,
      parts: state.parts,
      direction: context.direction,
      mode: parsedMode.kind === 'absolute'
        ? { kind: 'absolute', price2: parsedMode.price2 }
        : { kind: 'tickStep', tickSize: Number(tradeSymbol.filter.tickSize) },
    });

    if (!priceBuild.isValid) {
      return { isValid: false, error: priceBuild.error };
    }

    const precisePriceList = priceBuild.priceList.map((price) => Number(this.exchangeConnector.futures.priceToPrecision(context.symbol, price)));

    const amountBuild = buildAmountList({ totalContracts: context.contracts, parts: state.parts });
    const preciseAmountList = amountBuild.amountList.map((amount) => Number(this.exchangeConnector.futures.amountToPrecision(context.symbol, amount)));

    const allocatedExceptLast = preciseAmountList.slice(0, -1).reduce((sum, value) => sum + value, 0);
    const preciseLastAmount = Number(this.exchangeConnector.futures.amountToPrecision(context.symbol, context.contracts - allocatedExceptLast));

    preciseAmountList[preciseAmountList.length - 1] = preciseLastAmount;

    const minQty = this.exchangeConnector.futures.getMinOrderQty(context.symbol);

    for (let i = 0; i < preciseAmountList.length; i++) {
      if (preciseAmountList[i] < minQty) {
        return { isValid: false, error: `Too many parts — amount ${preciseAmountList[i]} is below min ${minQty}` };
      }
    }

    const plan: TpSplitPlanPart[] = precisePriceList.map((price, i) => ({ price, amount: preciseAmountList[i] }));

    return { isValid: true, plan };
  }

  private async handleTpSplitConfirm(ctx: Context): Promise<void> {
    const state = this.tpSplitState;

    if (!state || state.step !== 'confirm' || !state.plan || !state.parts) {
      try {
        await ctx.answerCbQuery('Session expired');
      } catch (error: unknown) {
        logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleTpSplitConfirm');
      }

      return;
    }

    const context = this.resolveTpSplitContext(state);

    if (!context) {
      this.tpSplitState = null;
      try {
        await ctx.answerCbQuery('Position not found');
      } catch (error: unknown) {
        logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleTpSplitConfirm (no position)');
      }

      return;
    }

    const plan = state.plan;
    const placementPositionId = context.isEphemeral
      ? `eph_${context.symbol}_${context.direction}_${Date.now()}`
      : context.position!.id;
    await this.startCallbackLoading(ctx, 'strip-keyboard');

    try {
      const priceList = plan.map((part) => part.price);
      const amountList = plan.map((part) => part.amount);

      const result = await this.placeTpSplitOrders({
        positionId: placementPositionId,
        symbol: context.symbol,
        direction: context.direction,
        priceList,
        amountList,
      });

      if (!result.isCreated) {
        await this.replaceMenu(ctx, {
          text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to create Split TP: ${result.errorText ?? 'Unknown error'}`),
        });

        return;
      }

      if (!context.isEphemeral && context.position !== null) {
        const position = context.position;
        const wasAutoCloseEnabled = position.isAutoCloseEnabled;

        // Placing a manual TP ladder means the user is taking over the exit — auto-close must turn OFF
        // and never re-enable itself (there is no auto re-enable path; only position creation defaults it
        // to true and the explicit Level-3 toggle can turn it back on).
        position.tpOrderIdList = result.orderIdList;
        position.isAutoCloseEnabled = false;

        await this.safeUpdateMonitoredPosition(position.id, {
          tpOrderIdList: result.orderIdList,
          isAutoCloseEnabled: false,
        });

        if (wasAutoCloseEnabled) {
          logger.info(
            { positionId: position.id, symbol: position.symbol },
            `[PnlMonitor] ${position.symbol} Auto-close disabled — user placed Split TP (will not re-enable automatically)`,
          );
        }
      }

      const message = formatTpSplitCreatedMessage({
        symbol: context.symbol,
        direction: context.direction,
        parts: priceList.length,
        firstPrice: priceList[0],
        lastPrice: priceList[priceList.length - 1],
      });

      logger.info(
        { positionId: context.position?.id ?? null, symbol: context.symbol, isEphemeral: context.isEphemeral, orderCount: result.orderIdList.length, orderIdList: result.orderIdList },
        `[PnlMonitor] ${context.symbol} Split TP created — ${result.orderIdList.length} orders placed${context.isEphemeral ? ' (ephemeral — not persisted)' : ', monitoring continues'}`,
      );
      // Terminal Split-TP-created message — sent via replaceMenu without inline keyboard so it lingers
      // as a chat record (not tracked for deletion on next navigation).
      const sentMessageId = await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(message),
      });

      if (sentMessageId !== null) {
        this.messageTracker.delete(this.chatId);
      }
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      logger.error({ error, positionId: context.position?.id ?? null, symbol: context.symbol, isEphemeral: context.isEphemeral }, `[PnlMonitor] ${context.symbol} Split TP confirm threw: ${errorText}`);
      await this.replaceMenu(ctx, {
        text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Failed to create Split TP: ${errorText}`),
      });
    } finally {
      this.tpSplitState = null;
    }
  }

  private async handleTpSplitCancel(ctx: Context): Promise<void> {
    this.tpSplitState = null;

    try {
      await ctx.answerCbQuery();
    } catch (error: unknown) {
      logger.warn({ error }, '[PnlMonitor] answerCbQuery failed in handleTpSplitCancel');
    }

    await this.replaceMenu(ctx, {
      text: escapeMarkdownV2WithFormatting(`${EMOJI_CROSS} Split TP cancelled`),
    });
  }

  private async handleTpSplitTextInput(ctx: Context): Promise<void> {
    const state = this.tpSplitState;

    if (!state) {
      return;
    }

    const message = ctx.message;

    if (!message || !('text' in message)) {
      return;
    }

    const text = (message as { text: string }).text;
    const context = this.resolveTpSplitContext(state);

    if (!context) {
      this.tpSplitState = null;

      return;
    }

    if (state.step === 'price1') {
      const parsed = parseFirstPriceInput(text);

      if (!parsed.isValid) {
        await this.editTpSplitPrompt(ctx, context, parsed.error);

        return;
      }

      const lastPrice = this.getLastPriceFromKline(context.symbol);

      if (lastPrice <= 0) {
        await this.editTpSplitPrompt(ctx, context, 'Cannot validate price — last price unavailable. Try again.');

        return;
      }

      const precisePrice = Number(this.exchangeConnector.futures.priceToPrecision(context.symbol, parsed.price));

      if (!validatePriceVsLast({ price: precisePrice, lastPrice, direction: context.direction })) {
        const directionLabel = formatDirection(context.direction);
        const comparator = context.direction === 'long' ? '>' : '<';
        const errorText = `First price for ${directionLabel} must be ${comparator} ${lastPrice} (last price). Got ${precisePrice}.`;
        await this.editTpSplitPrompt(ctx, context, errorText);

        return;
      }

      state.price1 = precisePrice;
      state.step = 'tpSize';
      await this.editTpSplitTpSize(ctx, context);

      return;
    }

    if (state.step === 'tpSize') {
      const parsed = parseOrderSizeInput({ text, minValue: 1 });

      if (!parsed.isValid) {
        await this.editTpSplitTpSize(ctx, context, parsed.error);

        return;
      }

      this.applyTpSizeToState(state, context, parsed.orderSize);
      state.step = 'mode';
      await this.editTpSplitMode(ctx, context);

      return;
    }

    if (state.step === 'mode') {
      const parsed = parseModeInput({ text });

      if (!parsed.isValid) {
        await this.editTpSplitMode(ctx, context, parsed.error);

        return;
      }

      const parsedMode: TpSplitParsedMode = parsed.kind === 'absolute'
        ? { kind: 'absolute', price2: Number(this.exchangeConnector.futures.priceToPrecision(context.symbol, parsed.price2)) }
        : { kind: 'percent', percent: 0 };

      const planResult = await this.computeTpSplitPlan(context, state, parsedMode);

      if (!planResult.isValid) {
        await this.editTpSplitMode(ctx, context, planResult.error);

        return;
      }

      state.parsedMode = parsedMode;
      state.plan = planResult.plan;
      state.step = 'confirm';
      await this.editTpSplitConfirm(ctx, context);
    }
  }

  private async editTpSplitPrompt(ctx: Context, context: TpSplitContext, errorText?: string): Promise<void> {
    const prefix = errorText ? `${EMOJI_CROSS} ${errorText}\n\n` : '';
    const header = await this.buildTpSplitHeader(context);
    const body = `${prefix}${header}\n\nStep 1/3: enter the first price`;

    await this.editSplitDialogMessage(ctx, body, {
      inline_keyboard: [[{ text: 'Cancel', callback_data: 'tp_split_cancel' }]],
    });
  }

  private async editTpSplitPromptForEphemeral(ctx: Context, snap: Position, direction: 'long' | 'short'): Promise<void> {
    const context: TpSplitContext = {
      symbol: snap.symbol,
      direction,
      contracts: snap.contracts,
      entryPrice: snap.entryPrice,
      isEphemeral: true,
      position: null,
    };

    await this.editTpSplitPrompt(ctx, context);
  }

  private async editTpSplitTpSize(ctx: Context, context: TpSplitContext, errorText?: string): Promise<void> {
    const prefix = errorText ? `${EMOJI_CROSS} ${errorText}\n\n` : '';
    const header = await this.buildTpSplitHeader(context);
    const totalPositionNotional = context.contracts * context.entryPrice;
    const body = `${prefix}${header}\n\nStep 2/3: TP order size in USDT (notional per TP order)\nTotal position notional: ≈ $${Math.floor(totalPositionNotional)}\n(parts count will be derived; minimum 2)`;
    const presetRowList = this.getTpSizePresetRowList();

    await this.editSplitDialogMessage(ctx, body, {
      inline_keyboard: [
        ...presetRowList,
        [{ text: 'Cancel', callback_data: 'tp_split_cancel' }],
      ],
    });
  }

  private async editTpSplitMode(ctx: Context, context: TpSplitContext, errorText?: string): Promise<void> {
    const prefix = errorText ? `${EMOJI_CROSS} ${errorText}\n\n` : '';
    const header = await this.buildTpSplitHeader(context);
    const body = `${prefix}${header}\n\nStep 3/3: enter the mode\n\`<price>\` — absolute second price (e.g. \`62150.75\`)\n\`<value>%\` — tick-by-tick step (only \`0%\` supported)`;

    await this.editSplitDialogMessage(ctx, body, {
      inline_keyboard: [[{ text: 'Cancel', callback_data: 'tp_split_cancel' }]],
    });
  }

  private async editTpSplitConfirm(ctx: Context, context: TpSplitContext): Promise<void> {
    const state = this.tpSplitState;

    if (!state || !state.plan || !state.parts) {
      return;
    }

    const header = await this.buildTpSplitHeader(context);
    const tpSizeDisplay = state.tpSize !== null && state.actualTpSize !== null
      ? { requestedTpSize: state.tpSize, actualTpSize: state.actualTpSize }
      : undefined;
    const maLevel: MaLevel = context.position?.maLevel ?? IMPORTED_POSITION_MA_LEVEL;
    const confirmation = formatTpSplitConfirmation({
      symbol: context.symbol,
      direction: context.direction,
      maLevel,
      parts: state.parts,
      totalContracts: context.contracts,
      entryPrice: context.entryPrice,
      partList: state.plan,
      tpSizeDisplay,
    });
    const body = `${header}\n\n${confirmation}`;

    await this.editSplitDialogMessage(ctx, body, {
      inline_keyboard: [
        [
          { text: `${EMOJI_CHECK} Create`, callback_data: 'tp_split_confirm' },
          { text: `${EMOJI_CROSS} Cancel`, callback_data: 'tp_split_cancel' },
        ],
      ],
    });
  }

  private async editSplitDialogMessage(ctx: Context, text: string, replyMarkup: { inline_keyboard: PnlAlertButton[][] }): Promise<void> {
    const state = this.tpSplitState;

    if (!state) {
      return;
    }

    const sentMessageId = await this.replaceMenu(ctx, {
      text: escapeMarkdownV2WithFormatting(text),
      replyMarkup,
    });

    if (sentMessageId !== null) {
      state.messageId = sentMessageId;
    }

    await this.deleteUserMessage(ctx);
  }

}

export { GenericPnlMonitor };
