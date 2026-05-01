export { ExchangeError } from '@solncebro/exchange-engine';

export { ExchangeConnector } from './services/exchangeConnector';
export { FirebaseServiceBase } from './services/firebaseServiceBase';
export { TelegramCommandHandler } from './services/telegramCommandHandler';
export { TelegramMessageListener } from './services/telegramMessageListener';
export { TelegramNotifier } from './services/telegramNotifier';

export { ConfigManager } from './core/config';
export { createLogger, logger } from './core/logger';
export { OrderCalculator } from './core/orderCalculator';
export { OrderExecutor } from './core/orderExecutor';
export { PositionManager } from './core/positionManager';
export type {
  CancelBatchOrdersArgs,
  CancelOrderArgs,
  ClosePositionLimitArgs,
  ClosePositionMarketArgs,
  Direction,
  OpenPositionLimitArgs,
  OpenPositionMarketArgs,
  PlaceStopLossArgs,
  PlaceTakeProfitArgs,
  SetLeverageArgs,
  SetMarginModeArgs,
  SpotMarketBuyByQuoteArgs,
  StopOrderType,
} from './core/positionManager.types';

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
