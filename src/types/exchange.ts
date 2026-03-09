import type { Position } from '@solncebro/exchange-engine';

import { ExtensibleRecord } from './common';
import { OrderParams } from './orders';

import { ExchangeConnector } from '../services/exchangeConnector';

export type ExchangeName = 'binance' | 'bybit';
export type ExchangeConnectorByName = Map<ExchangeName, ExchangeConnector>;

export enum MarginType {
  ISOLATED = 'isolated',
  CROSS = 'cross',
}

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
  average?: number;
  timestamp?: number;
  filled?: number;
  remaining?: number;
  cost?: number;
  fee?: {
    currency?: string;
    cost?: number;
  };
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

export interface PositionInfo {
  symbol: string;
  leverage: string;
  autoAddMargin: string;
  avgPrice: string;
  liqPrice: string;
  riskLimitValue: string;
  takeProfit: string;
  positionValue: string;
  isReduceOnly: boolean;
  positionIMByMp: string;
  tpslMode: string;
  riskId: string;
  trailingStop: string;
  liqPriceByMp: string;
  unrealisedPnl: string;
  markPrice: string;
  adlRankIndicator: string;
  cumRealisedPnl: string;
  positionMM: string;
  createdTime: string;
  positionIdx: string;
  positionIM: string;
  positionMMByMp: string;
  seq: string;
  updatedTime: string;
  side: string;
  bustPrice: string;
  positionBalance: string;
  leverageSysUpdatedTime: string;
  curRealisedPnl: string;
  size: string;
  positionStatus: string;
  mmrSysUpdatedTime: string;
  stopLoss: string;
  tradeMode: string;
  sessionAvgPrice: string;
}

export type PositionWithTypedInfo<T> = Omit<Position, 'info'> & { info: T };
