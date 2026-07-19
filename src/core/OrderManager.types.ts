import type { Direction } from './positionManager.types';

import { MarginModeEnum } from '../types/index';

type ConfirmedCancelInfo =
  | { kind: 'cancelled'; orderId: string; source: 'ws' | 'rest'; attemptCount: number; ageMs: number }
  | { kind: 'filled'; orderId: string; filledAmount: number; avgPrice: number; source: 'ws' | 'rest'; attemptCount: number; ageMs: number }
  | { kind: 'partial_then_terminal'; orderId: string; filledAmount: number; status: 'canceled' | 'expired'; source: 'ws' | 'rest'; attemptCount: number; ageMs: number };

type ExhaustedReason = 'max_attempts' | 'shutdown';

interface ExhaustedCancelInfo {
  orderId: string;
  reason: ExhaustedReason;
  attemptCount: number;
  ageMs: number;
  lastErrorMessage: string | null;
}

type ConfirmedCallback = (info: ConfirmedCancelInfo) => void | Promise<void>;
type ExhaustedCallback = (info: ExhaustedCancelInfo) => void | Promise<void>;

interface EnqueueCancelArgs {
  symbol: string;
  orderId: string;
  modulePrefix: string;
  contextLabel: string;
  metadata?: Record<string, unknown>;
  onConfirmed?: ConfirmedCallback;
  onExhausted?: ExhaustedCallback;
}

type ImmediateCancelResult = 'cancelled' | 'filled' | 'pending' | 'failed_to_send';

interface ImmediateCancelOutcome {
  immediateResult: ImmediateCancelResult;
  filledAmount?: number;
  avgPrice?: number;
  isStillTracked: boolean;
}

interface EnqueueCancelBatchArgs {
  symbol: string;
  orderIdList: string[];
  modulePrefix: string;
  contextLabel: string;
  metadata?: Record<string, unknown>;
  onConfirmed?: ConfirmedCallback;
  onExhausted?: ExhaustedCallback;
}

interface ImmediateBatchOutcome {
  cancelledOrderIdList: string[];
  pendingOrderIdList: string[];
  failedToSendOrderIdList: string[];
}

interface PendingCancelEntry {
  symbol: string;
  orderId: string;
  modulePrefix: string;
  contextLabel: string;
  metadata: Record<string, unknown>;
  attemptCount: number;
  firstAttemptAtMs: number;
  lastAttemptAtMs: number;
  cooldownUntilMs: number;
  lastErrorMessage: string | null;
  onConfirmedList: ConfirmedCallback[];
  onExhaustedList: ExhaustedCallback[];
}

interface OrderManagerDiagnostics {
  pendingCount: number;
  inFlightCount: number;
  oldestAgeMs: number;
}

interface ReplaceStopLossArgs {
  positionId: string;
  symbol: string;
  direction: Direction;
  oldOrderId: string | null;
  triggerPrice: number;
  amount: number;
  metadata?: Record<string, unknown>;
  onOldOrderConfirmed?: ConfirmedCallback;
}

interface ReplaceStopLossResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
}

interface EnqueueClosePositionMarketArgs {
  positionId: string;
  symbol: string;
  direction: Direction;
  amount: number;
  contextLabel: string;
  metadata?: Record<string, unknown>;
}

interface ClosePositionMarketResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
}

interface CreateTpSplitFanArgs {
  positionId: string;
  symbol: string;
  direction: Direction;
  priceList: number[];
  amountList: number[];
  metadata?: Record<string, unknown>;
}

interface CreateTpSplitFanResult {
  isCreated: boolean;
  orderIdList: string[];
  errorText: string | null;
}

interface CreateLimitOrderArgs {
  symbol: string;
  direction: Direction;
  amount: number;
  price: number;
  contextLabel: string;
  metadata?: Record<string, unknown>;
}

interface CreateLimitOrderResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
}

interface MoveLimitOrderArgs {
  symbol: string;
  direction: Direction;
  oldOrderId: string;
  amount: number;
  newPrice: number;
  contextLabel: string;
  metadata?: Record<string, unknown>;
  onOldOrderConfirmed?: ConfirmedCallback;
}

interface MoveLimitOrderResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
  oldCancelOutcome: ImmediateCancelOutcome;
}

interface CreateMultiOrderBatchPart {
  amount: number;
  price: number;
}

interface CreateMultiOrderBatchArgs {
  symbol: string;
  direction: Direction;
  partList: CreateMultiOrderBatchPart[];
  leverage?: number;
  marginMode?: MarginModeEnum;
  contextLabel: string;
  metadata?: Record<string, unknown>;
}

interface CreateMultiOrderBatchResult {
  isCreated: boolean;
  orderIdList: string[];
  errorText: string | null;
  isPartial: boolean;
  placedCount: number;
  requestedCount: number;
  failedPartList: CreateMultiOrderBatchPart[];
  placedOrderIdByCanonicalIndex: (string | null)[];
}

export type {
  ConfirmedCancelInfo,
  ExhaustedCancelInfo,
  ExhaustedReason,
  ConfirmedCallback,
  ExhaustedCallback,
  EnqueueCancelArgs,
  EnqueueCancelBatchArgs,
  ImmediateCancelOutcome,
  ImmediateCancelResult,
  ImmediateBatchOutcome,
  PendingCancelEntry,
  OrderManagerDiagnostics,
  ReplaceStopLossArgs,
  ReplaceStopLossResult,
  EnqueueClosePositionMarketArgs,
  ClosePositionMarketResult,
  CreateTpSplitFanArgs,
  CreateTpSplitFanResult,
  CreateLimitOrderArgs,
  CreateLimitOrderResult,
  MoveLimitOrderArgs,
  MoveLimitOrderResult,
  CreateMultiOrderBatchPart,
  CreateMultiOrderBatchArgs,
  CreateMultiOrderBatchResult,
};
