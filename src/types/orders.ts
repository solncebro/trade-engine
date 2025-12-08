import {
  ExchangeName,
  ExchangeOrderParams,
  ExchangeResponseData,
} from './exchange';

import { ExchangeConnector } from '../services/exchangeConnector';

export enum TimeInForce {
  GTC = 'GTC',
  IOC = 'IOC',
  FOK = 'FOK',
  PostOnly = 'PostOnly',
}

export enum OrderType {
  Market = 'market',
  Limit = 'limit',
}

export type OrderSide = 'long' | 'short';

export enum OrderDirection {
  Buy = 'buy',
  Sell = 'sell',
}

export interface OrderParams {
  symbol: string;
  side: OrderDirection;
  amount: number;
  price: number;
  type: OrderType;
  triggerPrice?: number;
  triggerDirection?: 1 | 2;
  params?: Record<string, unknown>;
}

export interface EntityWithOrderId {
  orderId?: string;
}

export interface EntityWithErrorText {
  errorText?: string;
}

export interface OrderAttributes extends EntityWithErrorText {
  orderParams: OrderParams;
  exchangeName: ExchangeName;
}

export interface OrderResult extends OrderAttributes, EntityWithOrderId {
  actualExchangeParams?: ExchangeOrderParams;
  responseData?: ExchangeResponseData;
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

export type SymbolMappingByExchange = Map<ExchangeName, Map<string, string>>;

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
