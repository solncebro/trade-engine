import type { KlineInterval } from '@solncebro/exchange-engine';

export type MaLevel = 25 | 50 | 100 | 200;

export const MA_LEVEL_LIST: MaLevel[] = [25, 50, 100, 200];

export const VOLUME_SMA_PERIOD = 20;

export const ALL_SUPPORTED_INTERVAL_LIST = ['30m', '5m', '4h'] as const satisfies readonly KlineInterval[];

export interface MaValues {
  ma25: number;
  ma50: number;
  ma100: number;
  ma200: number;
}

export interface MonitoredPosition {
  id: string;
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  avgPriceOffsetPercent: number;
  volumeUsdt: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  contracts: number;
  lastAcknowledgedThreshold: number;
  stopLossOrderId: string | null;
  currentStopLossLevel: number;
  stopLossLastErrorText: string | null;
  insuranceChaserId: string | null;
  insuranceFailReason: string | null;
  isInsuranceUnavailableNotified: boolean;
  isLossAlertAcknowledged: boolean;
  isUserResponded: boolean;
  isAutoCloseNotified: boolean;
  lastAlertMessageId: number | null;
  tpOrderIdList: string[] | null;
  multiEntryOrderIdList: string[] | null;
  primaryOrderCount: number;
  primarySpreadPercent: number | null;
  primaryAvgVolumeOffsetPercent: number | null;
  plannedNotionalUsdt: number;
  lastFillKlineOpenTimestamp: number | null;
  entryKlineHighSnapshot: number | null;
  entryKlineLowSnapshot: number | null;
  halveEnableKlineHighSnapshot: number | null;
  halveEnableKlineLowSnapshot: number | null;
  halveEnableKlineOpenTimestamp: number | null;
  isHalveAtBreakevenEnabled: boolean;
  hasInsuranceCycleCompleted: boolean;
  isAugmented: boolean;
  isTrailingSlEnabled: boolean;
  isPnlAlertsEnabled: boolean;
  isAutoCloseEnabled: boolean;
  isImported: boolean;
  createdAt: number;
}

export interface MonitoredPositionsDocument {
  [positionId: string]: MonitoredPosition;
}
