import type { ExchangeName } from '@solncebro/exchange-engine';

import { ExtensibleRecord } from './common';
import { OrderParams } from './orders';

import { ExchangeConnector } from '../services/exchangeConnector';

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
