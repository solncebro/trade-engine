import type { ExchangeNameEnum, OrderRateLimitSnapshot } from '@solncebro/exchange-engine';

import { ExtensibleRecord } from './common';
import { OrderParams } from './orders';

import { ExchangeConnector } from '../services/exchangeConnector';

export type ExchangeConnectorByName = Map<ExchangeNameEnum, ExchangeConnector>;

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
  /** Placement: the amount the exchange accepted, from its answer (Binance cuts a closing order
   *  larger than the position right there). Absent when the answer carries only the number (Bybit, OKX). */
  amount?: number;
  /** Placement: the order status from the exchange answer; absent where `amount` is absent. */
  status?: string;
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
  rateLimit?: OrderRateLimitSnapshot;
}

export interface ErrorResultBase {
  exchangeName: ExchangeNameEnum;
  orderParams: OrderParams;
}
