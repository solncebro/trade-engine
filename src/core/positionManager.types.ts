import { MarginModeEnum, MarketTypeEnum, OrderSideEnum, OrderTypeEnum, TriggerByEnum } from '@solncebro/exchange-engine';

export type Direction = 'long' | 'short';

export type StopOrderType = 'Market' | 'Limit';

export interface PlaceConditionalArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  triggerPrice: number;
  amount: number;
  triggerBy?: TriggerByEnum;
  orderType?: StopOrderType;
  limitPrice?: number;
  clientOrderId?: string;
  isStopLoss: boolean;
}

export interface BuildOrderParamsInput {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  side: OrderSideEnum;
  amount: number;
  price: number;
  type: OrderTypeEnum;
  isReduceOnly: boolean;
  clientOrderId?: string;
}

export interface ApplyFuturesSetupArgs {
  marketType: MarketTypeEnum;
  symbol: string;
  leverage?: number;
  marginMode?: MarginModeEnum;
}

export interface OpenPositionLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  price: number;
  leverage?: number;
  marginMode?: MarginModeEnum;
  clientOrderId?: string;
}

export interface OpenPositionMarketArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  leverage?: number;
  marginMode?: MarginModeEnum;
  clientOrderId?: string;
}

export interface ClosePositionLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  price: number;
  clientOrderId?: string;
}

export interface ClosePositionMarketArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  clientOrderId?: string;
}

export interface PlaceStopLossArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  triggerPrice: number;
  amount: number;
  triggerBy?: TriggerByEnum;
  orderType?: StopOrderType;
  limitPrice?: number;
  clientOrderId?: string;
}

export interface PlaceTakeProfitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  triggerPrice: number;
  amount: number;
  triggerBy?: TriggerByEnum;
  orderType?: StopOrderType;
  limitPrice?: number;
  clientOrderId?: string;
}

export interface CancelOrderArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  orderId: string;
}

export interface CancelBatchOrdersArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  orderIdList: string[];
}

export interface SpotMarketBuyByQuoteArgs {
  symbol: string;
  quoteAmount: number;
  clientOrderId?: string;
}

export interface SetLeverageArgs {
  symbol: string;
  leverage: number;
}

export interface SetMarginModeArgs {
  symbol: string;
  marginMode: MarginModeEnum;
}
