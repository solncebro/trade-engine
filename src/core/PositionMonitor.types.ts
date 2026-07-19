import type { MarketDataSource } from './marketDataSource.types';
import type { OrderManager } from './OrderManager';
import type { PositionStore } from './positionStore.types';

import type { ExchangeConnector } from '../services/exchangeConnector';
import type { KlineInterval, MaLevel, PositionModeEnum } from '../types/index';

interface PositionMonitorArgs {
  exchangeConnector: ExchangeConnector;
  orderManager: OrderManager;
  marketDataManagerByInterval: Map<KlineInterval, MarketDataSource>;
  positionMode: PositionModeEnum;
  positionStore: PositionStore;
}

type StopLossStatus = 'active' | 'recreated' | 'missing';

interface ExternalMultiEntryCancelBufferEntry {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  cancelledCount: number;
  cancelType: string | undefined;
}

interface MultiOrderTimeoutNotifyArgs {
  positionId: string;
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  cancelledCount: number;
  absentCount: number;
  timeoutKlineCount: number;
}

interface PositionRemovedExternallyNotifyArgs {
  symbol: string;
  timeframe: KlineInterval;
  direction: 'long' | 'short';
  maLevel: MaLevel;
  isAugmented: boolean;
  lastPnlPercent: number | null;
  confirmationTickCount: number;
  confirmationWindowSeconds: number;
}

interface ImportFibPositionArgs {
  symbol: string;
  direction: 'long' | 'short';
  remainingEntryOrderIdList: string[];
  leverage: number;
}

interface PlaceFibBreakevenExitArgs {
  positionId: string;
  fibAvgEntry: number;
  epsPercent: number;
  orderCount: number;
}

interface PlaceFibTakeProfitArgs {
  positionId: string;
  price: number;
}

interface TpSplitOrderPlacementArgs {
  positionId: string;
  symbol: string;
  direction: 'long' | 'short';
  priceList: number[];
  amountList: number[];
}

interface TpSplitOrderPlacementResult {
  isCreated: boolean;
  orderIdList: string[];
  errorText: string | null;
}

export type {
  PositionMonitorArgs,
  StopLossStatus,
  ExternalMultiEntryCancelBufferEntry,
  MultiOrderTimeoutNotifyArgs,
  PositionRemovedExternallyNotifyArgs,
  ImportFibPositionArgs,
  PlaceFibBreakevenExitArgs,
  PlaceFibTakeProfitArgs,
  TpSplitOrderPlacementArgs,
  TpSplitOrderPlacementResult,
};
