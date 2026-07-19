import type { MarketDataSource } from './marketDataSource.types';
import type { OrderManager } from './OrderManager';
import type { PositionStore } from './positionStore.types';

import type { ExchangeConnector } from '../services/exchangeConnector';
import type { KlineInterval, MaLevel, MonitoredPosition, PositionModeEnum } from '../types/index';

interface PnlConfig {
  profitThresholdPercent: number;
  profitAutoClosePercent: number;
  lossThresholdPercent: number;
  breakevenHalfClosePercent: number;
  trailingStopLossStepPercent: number;
}

interface GenericPnlMonitorArgs {
  exchangeConnector: ExchangeConnector;
  orderManager: OrderManager;
  marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  positionMode: PositionModeEnum;
  positionStore: PositionStore;
  pnlBotToken: string;
  chatId: string;
  getPnlConfig: () => PnlConfig;
}

interface PnlAlertButton {
  text: string;
  callback_data: string;
}

interface PositionsReplyContext {
  reply: (text: string, extra: Record<string, unknown>) => Promise<unknown>;
}

type TpSplitStep = 'price1' | 'tpSize' | 'mode' | 'confirm';

type TpSplitParsedMode =
  | { kind: 'absolute'; price2: number }
  | { kind: 'percent'; percent: 0 };

interface TpSplitPlanPart {
  price: number;
  amount: number;
}

interface TpSplitState {
  positionId: string | null;
  ephemeralKey: string | null;
  step: TpSplitStep;
  messageId: number;
  price1: number | null;
  tpSize: number | null;
  actualTpSize: number | null;
  parts: number | null;
  parsedMode: TpSplitParsedMode | null;
  plan: TpSplitPlanPart[] | null;
}

interface TpSplitContext {
  symbol: string;
  direction: 'long' | 'short';
  contracts: number;
  entryPrice: number;
  isEphemeral: boolean;
  position: MonitoredPosition | null;
}

interface PositionViewState {
  lastPrice: number;
  pnlPercent: number;
  liquidationDistancePercent: number;
  hasInsurance: boolean;
  insuranceMaLevel: MaLevel | null;
  isInsuranceMissing: boolean;
  isHalveMarkActive: boolean;
}

interface InsuranceViewState {
  hasInsurance: boolean;
  insuranceMaLevel: MaLevel | null;
  isInsuranceMissing: boolean;
}

type MonitoringFlagFieldName = 'isTrailingSlEnabled' | 'isPnlAlertsEnabled' | 'isAutoCloseEnabled';

interface AutoTpToggleOptions {
  shouldStopAlarmWhenDisabled: boolean;
}

export type {
  PnlConfig,
  GenericPnlMonitorArgs,
  PnlAlertButton,
  PositionsReplyContext,
  TpSplitStep,
  TpSplitParsedMode,
  TpSplitPlanPart,
  TpSplitState,
  TpSplitContext,
  PositionViewState,
  InsuranceViewState,
  MonitoringFlagFieldName,
  AutoTpToggleOptions,
};
