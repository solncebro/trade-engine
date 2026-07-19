export { ExchangeError } from '@solncebro/exchange-engine';

export { ExchangeConnector } from './services/exchangeConnector';
export type {
  RateLimitConfig,
  StreamWatchdogConfigMap,
  StreamWatchdogStreamConfig,
} from './services/exchangeConnector';
export { FirebaseServiceBase } from './services/firebaseServiceBase';
export { KlineSubscriptionWatchdog } from './services/klineSubscriptionWatchdog';
export type {
  KlineSubscriptionLastEntry,
  KlineSubscriptionOverdueEntry,
  KlineSubscriptionRecoveryState,
  KlineSubscriptionWatchdogArgs,
  KlineSubscriptionWatchdogConfig,
  KlineSubscriptionWatchdogDiagnostic,
  KlineWatchdogHealthEvent,
} from './services/klineSubscriptionWatchdog.types';
export { PremiumIndexCalculator } from './services/premiumIndexCalculator';
export { StreamSubscriptionWatchdog } from './services/streamSubscriptionWatchdog';
export type {
  StreamHealthEvent,
  StreamLastEntry,
  StreamRecoveryAttemptResult,
  StreamSubscriptionWatchdogArgs,
  StreamSubscriptionWatchdogConfig,
  StreamSubscriptionWatchdogDiagnostic,
  StreamType,
  StreamWatchdogCallbacks,
  StreamWatchdogStrategy,
} from './services/streamSubscriptionWatchdog.types';
export {
  buildOrderbookWatchdogKey,
  buildPublicTradeWatchdogKey,
  MARK_PRICE_WATCHDOG_KEY,
  MarkPriceWatchdogStrategy,
  OrderbookWatchdogStrategy,
  PublicTradeWatchdogStrategy,
} from './services/streamWatchdogStrategies';
export { TelegramCommandHandler } from './services/telegramCommandHandler';
export { TelegramMessageListener } from './services/telegramMessageListener';
export { TelegramNotifier } from './services/telegramNotifier';

export { ConfigManager } from './core/config';
export { createLogger, logger } from './core/logger';
export { LogThrottle } from './core/logThrottle';
export type { ThrottledLogArgs } from './core/logThrottle';
export { OrderCalculator } from './core/orderCalculator';
export { OrderExecutor } from './core/orderExecutor';
export { PositionManager } from './core/positionManager';
export type {
  CancelAllOrdersArgs,
  CancelBatchOrdersArgs,
  CancelOrderArgs,
  ClosePositionBatchLimitArgs,
  ClosePositionBatchLimitItem,
  ClosePositionBatchLimitResult,
  ClosePositionLimitArgs,
  ClosePositionMarketArgs,
  Direction,
  OpenPositionBatchLimitArgs,
  OpenPositionBatchLimitItem,
  OpenPositionBatchLimitResult,
  OpenPositionLimitArgs,
  OpenPositionMarketArgs,
  PlaceStopLossArgs,
  PlaceTakeProfitArgs,
  PositionAbsenceReason,
  PositionAmbiguityReason,
  PositionBatchLimitItemResult,
  PositionManagerModifyBatchOrderItem,
  PositionManagerModifyBatchOrdersArgs,
  PositionManagerModifyOrderArgs,
  PositionStateResult,
  ReadAllPositionsArgs,
  ReadPositionStateArgs,
  SetLeverageArgs,
  SetMarginModeArgs,
  SpotMarketBuyByQuoteArgs,
  StopOrderType,
} from './core/positionManager.types';
export { RateLimitedRequestQueue } from './core/RateLimitedRequestQueue';
export type { RateLimitedRequestQueueArgs } from './core/RateLimitedRequestQueue.types';
export { withReadRetry, withRetryOn429 } from './core/withRetryOn429';
export type {
  WithReadRetryArgs,
  WithRetryOn429Args,
} from './core/withRetryOn429.types';

export * from './types';

export {
  createDate,
  createHumanTimestamp,
  formatTimestamp,
} from './utils/date.utils';
export { isOrderSuccessful, isSpot } from './utils/order.utils';
export { ReadlineHelper } from './utils/readline.utils';
export { normalizeSymbol } from './utils/symbol.utils';
export { getCommandFromKey } from './utils/telegramCommand.utils';
