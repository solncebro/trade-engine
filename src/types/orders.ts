import {
  ExchangeName,
  ExchangeOrderParams,
  ExchangeResponseData,
} from './exchange';

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
  params?: Record<string, unknown>;
}

export interface EntiryWithOrderId {
  orderId?: string;
}

export interface EntiryWithErrorText {
  errorText?: string;
}

export interface OrderAttributes extends EntiryWithErrorText {
  orderParams: OrderParams;
  exchangeName: ExchangeName;
}

export interface OrderResult extends OrderAttributes, EntiryWithOrderId {
  actualExchangeParams?: ExchangeOrderParams;
  responseData?: ExchangeResponseData;
}

export interface CloseOrderResult
  extends EntiryWithErrorText,
    EntiryWithOrderId {
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
}

export interface SignalExecutionDetails extends OrderResult {
  takeProfitOrderResult?: CloseOrderResult;
  stopLossOrderResult?: CloseOrderResult;
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
