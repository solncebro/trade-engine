import { ExtensibleRecord } from './common';
import { OrderParams } from './orders';

import { ExchangeConnector } from '../services/exchangeConnector';

export type ExchangeName = 'binance' | 'bybit';
export type ExchangeConnectorByName = Map<ExchangeName, ExchangeConnector>;

export interface ExchangeOrderParams extends ExtensibleRecord {
  symbol: string;
  side: string;
  amount?: number;
  qty?: string;
  type?: string;
  orderType?: string;
  price?: number | string;
  category?: string;
  timeInForce?: string;
  params?: Record<string, unknown>;
  hedgeMode?: boolean;
  reduceOnly?: boolean;
}

export interface ExchangeResponseData extends ExtensibleRecord {
  id?: string;
  orderId?: string;
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
  timestamp?: number;
  filled?: number;
  remaining?: number;
  cost?: number;
  fee?: {
    currency?: string;
    cost?: number;
  };
}

export interface TickerData {
  symbol: string;
  close: number;
  timestamp: number;
  percentage?: number;
}

export interface TickerInfo extends ExtensibleRecord {
  close?: number;
  timestamp?: number;
  symbol?: string;
}

export interface MarketInfo extends ExtensibleRecord {
  symbol: string;
  type: string;
  id?: string;
  active?: boolean;
}

export interface BybitResponse {
  retCode?: number;
  retMsg?: string;
}

export interface ErrorResultBase {
  exchangeName: ExchangeName;
  orderParams: OrderParams;
}

export interface ExchangeErrorInfo {
  name: string;
  message: string;
  code?: string | number;
  response?: unknown;
  status?: number;
  statusText?: string;
}

export interface CreateBybitErrorResultArgs {
  resultBase: ErrorResultBase;
  response: BybitResponse;
  actualExchangeParams: ExchangeOrderParams;
  prefix?: string;
}
