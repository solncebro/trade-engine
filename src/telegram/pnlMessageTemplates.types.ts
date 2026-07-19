import type { KlineInterval, MaLevel } from '../types/index';

type StopLossStatus = 'active' | 'recreated' | 'missing';

interface ProfitAlertMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  pnlPercent: number;
  entryPrice: number;
  lastPrice: number;
  maLevel: MaLevel;
  isAugmented: boolean;
  stopLossLevel: number;
  stopLossStatus?: StopLossStatus;
  stopLossOrderId?: string | null;
  stopLossErrorText?: string | null;
}

interface LossAlertMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  pnlPercent: number;
  entryPrice: number;
  lastPrice: number;
  maLevel: MaLevel;
  isAugmented: boolean;
  isInsuranceCreated: boolean;
  isInsuranceLinked: boolean;
  insuranceMaLevel: MaLevel | null;
  insuranceFailReason: string | null;
}

interface AutoCloseMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  pnlPercent: number;
  entryPrice: number;
  lastPrice: number;
  maLevel: MaLevel;
  isAugmented: boolean;
}

interface PositionClosedMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  entryPrice: number;
  isAugmented: boolean;
}

interface AutoCloseCancelledMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  thresholdPercent: number;
  entryPrice: number;
  isAugmented: boolean;
}

interface PositionListItem {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  breakevenPrice: number;
  volumeUsdt: number;
  leverage: number;
  contracts: number;
  plannedNotionalUsdt: number;
  liquidationPrice: number;
  liquidationDistancePercent: number;
  pnlPercent: number;
  hasInsurance: boolean;
  insuranceMaLevel: MaLevel | null;
  isInsuranceMissing: boolean;
  isHalveMarkActive: boolean;
  isAugmented: boolean;
  isImported: boolean;
  breakevenHalfClosePercent: number;
  isTrailingSlEnabled: boolean;
  isPnlAlertsEnabled: boolean;
  isAutoCloseEnabled: boolean;
}

interface EphemeralPositionListItem {
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  contracts: number;
  leverage: number;
  markPrice: number;
  pnlPercent: number;
  liquidationPrice: number;
}

interface PositionsListMessageArgs {
  exchangeLabel: string;
  trackedList: PositionListItem[];
  ephemeralList: EphemeralPositionListItem[];
}

interface MaValueWithOffset {
  level: MaLevel;
  price: number;
  offsetFromLastPercent: number;
}

interface PositionDetailMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  contracts: number;
  entryPrice: number;
  breakevenPrice: number;
  lastPrice: number;
  liquidationPrice: number;
  liquidationDistancePercent: number;
  pnlPercent: number;
  pnlUsdt: number;
  volumeUsdt: number;
  leverage: number;
  plannedNotionalUsdt: number;
  maValueList: MaValueWithOffset[];
  hasInsurance: boolean;
  insuranceMaLevel: MaLevel | null;
  isInsuranceMissing: boolean;
  isHalveMarkActive: boolean;
  isAugmented: boolean;
  isImported: boolean;
  breakevenHalfClosePercent: number;
  isTrailingSlEnabled: boolean;
  isPnlAlertsEnabled: boolean;
  isAutoCloseEnabled: boolean;
}

interface EphemeralPositionDetailMessageArgs {
  symbol: string;
  direction: 'long' | 'short';
  contracts: number;
  entryPrice: number;
  lastPrice: number;
  liquidationPrice: number;
  leverage: number;
  pnlPercent: number;
  pnlUsdt: number;
}

interface TpSplitPart {
  price: number;
  amount: number;
}

interface TpSplitSizeDisplay {
  requestedTpSize: number;
  actualTpSize: number;
}

interface TpSplitConfirmationArgs {
  symbol: string;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  parts: number;
  totalContracts: number;
  entryPrice: number;
  partList: TpSplitPart[];
  tpSizeDisplay?: TpSplitSizeDisplay;
}

interface TpSplitCreatedMessageArgs {
  symbol: string;
  direction: 'long' | 'short';
  parts: number;
  firstPrice: number;
  lastPrice: number;
}

interface InsuranceFilledMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  entryPrice: number;
  breakevenPrice: number;
  lastPrice: number;
  pnlPercent: number;
  contracts: number;
  breakevenHalfClosePercent: number;
  profitThresholdPercent: number;
  profitAutoClosePercent: number;
}

interface InsuranceAdditionalFillMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  previousEntryPrice: number;
  entryPrice: number;
  previousBreakevenPrice: number;
  breakevenPrice: number;
  lastPrice: number;
  pnlPercent: number;
  contracts: number;
  breakevenHalfClosePercent: number;
}

interface SosMarkedMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  entryPrice: number;
  breakevenPrice: number;
  lastPrice: number;
  pnlPercent: number;
  contracts: number;
  breakevenHalfClosePercent: number;
  isAugmented: boolean;
}

interface PositionAugmentedMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  previousEntryPrice: number;
  entryPrice: number;
  previousContracts: number;
  contracts: number;
  lastPrice: number;
  pnlPercent: number;
  liquidationPrice: number;
}

interface HalfClosedMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  entryPrice: number;
  pnlPercent: number;
  lastPrice: number;
  closedContracts: number;
  remainingContracts: number;
  isAugmented: boolean;
}

interface SosCancelledMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  // Set to the MA level of a pending insurance order that was cancelled together with the SOS
  // (auto-SOS cancelled before fill). null for manual SOS / post-fill SOS (no live insurance order).
  cancelledInsuranceMaLevel: MaLevel | null;
}

interface TpCancelledMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  cancelledCount: number;
  failedCount: number;
}

interface PendingEntriesCancelledMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  cancelledCount: number;
}

interface AutoTpMenuMessageArgs {
  symbol: string;
  direction: 'long' | 'short';
  isTrailingSlEnabled: boolean;
  isPnlAlertsEnabled: boolean;
  isAutoCloseEnabled: boolean;
}

interface PositionRemovedExternallyMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  lastPnlPercent: number | null;
  confirmationTickCount: number;
  confirmationWindowSeconds: number;
}

interface ExternalMultiEntryCancelMessageArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  cancelledCount: number;
  remainingCount: number;
  cancelType: string | undefined;
}

export type { ExternalMultiEntryCancelMessageArgs, ProfitAlertMessageArgs, LossAlertMessageArgs, AutoCloseMessageArgs, PositionClosedMessageArgs, AutoCloseCancelledMessageArgs, PositionListItem, EphemeralPositionListItem, PositionsListMessageArgs, MaValueWithOffset, PositionDetailMessageArgs, EphemeralPositionDetailMessageArgs, StopLossStatus, TpSplitPart, TpSplitSizeDisplay, TpSplitConfirmationArgs, TpSplitCreatedMessageArgs, InsuranceFilledMessageArgs, InsuranceAdditionalFillMessageArgs, SosMarkedMessageArgs, SosCancelledMessageArgs, TpCancelledMessageArgs, PendingEntriesCancelledMessageArgs, AutoTpMenuMessageArgs, PositionAugmentedMessageArgs, HalfClosedMessageArgs, PositionRemovedExternallyMessageArgs };
