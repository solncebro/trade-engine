import { ExchangeNameEnum, MarketTypeEnum, OrderSideEnum, OrderTypeEnum, PositionSideEnum } from '@solncebro/exchange-engine';

import {
  ExchangeOrderParams,
  ExchangeResponseData,
} from './exchange';

import { ExchangeConnector } from '../services/exchangeConnector';

export interface OrderParams {
  symbol: string;
  side: OrderSideEnum;
  amount: number;
  price: number;
  type: OrderTypeEnum;
  marketType?: MarketTypeEnum;
  positionSide?: PositionSideEnum;
  triggerPrice?: number;
  triggerDirection?: 1 | 2;
  params?: Record<string, unknown>;
}

export interface EntityWithOrderId {
  orderId?: string;
}

export interface EntityWithErrorText {
  errorText?: string;
  errorCode?: number | string;
}

export interface OrderAttributes extends EntityWithErrorText {
  orderParams: OrderParams;
  exchangeName: ExchangeNameEnum;
  orderVolumeUsdt?: number;
}

export interface OrderResult extends OrderAttributes, EntityWithOrderId {
  actualExchangeParams?: ExchangeOrderParams;
  responseData?: ExchangeResponseData;
  attemptCount?: number;
}

export interface CloseOrderResult
  extends EntityWithErrorText,
    EntityWithOrderId {
  price?: number;
}

export interface OrderTiming {
  requestSentAt: number;
  responseReceivedAt: number;
}

export interface OrderTimings {
  signalReceivedAt: number;
  entryOrder: OrderTiming;
  takeProfitOrder?: OrderTiming;
  stopLossOrder?: OrderTiming;
  emergencyExitOrder?: OrderTiming;
}

export interface SignalExecutionDetails extends OrderResult {
  takeProfitOrderResult?: CloseOrderResult;
  stopLossOrderResult?: CloseOrderResult;
  emergencyExitOrderResult?: CloseOrderResult;
  timings?: OrderTimings;
}

export interface SignalRejectionArgs {
  message: string;
  logData: Record<string, unknown>;
}

export interface SymbolMappingResult {
  exchangeName: string;
  originalSymbol: string;
  resolvedSymbol: string;
}

export type SymbolMappingByExchange = Map<ExchangeNameEnum, Map<string, string>>;

export interface CreateOrderArgs {
  exchangeConnector: ExchangeConnector;
  orderParams: OrderParams;
}

export interface CreateCloseOrderArgs {
  exchangeConnector: ExchangeConnector;
  orderParams: OrderParams;
  priceShiftPercent: number;
  isTakeProfit: boolean;
  isEmergencyExitPosition?: boolean;
}

export interface CalculateAmountForMarketTypeArgs {
  price: number;
  allowedVolumeUsdt: number;
  uniqueSymbolCount: number;
  leverage: number;
  marketType: MarketTypeEnum;
}
