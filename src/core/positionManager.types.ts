import { MarginModeEnum, MarketTypeEnum, OrderSideEnum, OrderTypeEnum, Position, TriggerByEnum } from '@solncebro/exchange-engine';

export type Direction = 'long' | 'short';

export interface ReadPositionStateArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
}

export interface ReadAllPositionsArgs {
  marketType: MarketTypeEnum;
}

export type PositionAbsenceReason = 'no_record' | 'zero_contracts' | 'fetch_error';

export type PositionAmbiguityReason = 'side_mismatch' | 'idx_mismatch';

export type PositionStateResult =
  | { kind: 'present'; position: Position }
  | { kind: 'absent'; confidence: 'confirmed' | 'unconfirmed'; reason: PositionAbsenceReason; errorText?: string }
  | { kind: 'ambiguous'; reason: PositionAmbiguityReason; position: Position };

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

export interface CancelAllOrdersArgs {
  symbol: string;
  marketType: MarketTypeEnum;
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

export interface PositionManagerModifyOrderArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  orderId: string;
  price?: number;
  amount?: number;
  triggerPrice?: number;
}

export interface PositionManagerModifyBatchOrderItem {
  symbol: string;
  orderId: string;
  side: OrderSideEnum;
  price?: number;
  amount?: number;
  triggerPrice?: number;
  clientOrderId?: string;
}

export interface PositionManagerModifyBatchOrdersArgs {
  marketType: MarketTypeEnum;
  orderList: PositionManagerModifyBatchOrderItem[];
}

export interface OpenPositionBatchLimitItem {
  direction: Direction;
  amount: number;
  price: number;
  clientOrderId?: string;
}

export interface OpenPositionBatchLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  itemList: OpenPositionBatchLimitItem[];
  leverage?: number;
  marginMode?: MarginModeEnum;
}

export interface ClosePositionBatchLimitItem {
  direction: Direction;
  amount: number;
  price: number;
  clientOrderId?: string;
}

export interface ClosePositionBatchLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  itemList: ClosePositionBatchLimitItem[];
}

export interface PositionBatchLimitItemResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
}

export type OpenPositionBatchLimitResult = PositionBatchLimitItemResult[];

export type ClosePositionBatchLimitResult = PositionBatchLimitItemResult[];
