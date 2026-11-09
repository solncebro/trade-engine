import { MarginModeEnum, MarketTypeEnum, OrderSideEnum, OrderTypeEnum, Position, PositionModeEnum, TimeInForceEnum, TriggerByEnum } from '@solncebro/exchange-engine';
import type { FetchIncomeArgs, FetchOrderExecutionSummaryArgs, FetchPageWithLimitArgs } from '@solncebro/exchange-engine';

export type Direction = 'long' | 'short';

export interface ReadPositionStateArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
}

export interface ReadAllPositionsArgs {
  marketType: MarketTypeEnum;
}

export interface ReadOpenOrderListArgs {
  symbol: string;
  marketType: MarketTypeEnum;
}

export interface ReadOrderArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  orderId: string;
}

export interface ReadOrderExecutionSummaryArgs extends FetchOrderExecutionSummaryArgs {
  marketType: MarketTypeEnum;
}

export interface ReadAccountTradesArgs extends FetchPageWithLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
}

export type ReadIncomeArgs = FetchIncomeArgs;

export interface ReadOrderHistoryArgs extends FetchPageWithLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
}

export interface ReadClosedPnlArgs extends FetchPageWithLimitArgs {
  symbol?: string;
}

export interface ReadOpenPlainOrderListArgs {
  marketType: MarketTypeEnum;
  /** Omitted — every symbol of the account. */
  symbol?: string;
}

export interface ReadOpenConditionalOrderListArgs {
  /** Omitted — every symbol of the account. */
  symbol?: string;
  /** Settlement coin of the conditional order list; default 'USDT'. */
  settleCoin?: string;
}

export interface ReadOrderByClientOrderIdArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  clientOrderId: string;
}

export interface ReadFeeRateArgs {
  symbol: string;
  marketType: MarketTypeEnum;
}

export interface ReadFundingRateHistoryArgs {
  symbol: string;
  startTime: number;
  endTime: number;
  shouldIncludeMarkPrices?: boolean;
}

export interface FundingRateHistoryWindow {
  startTime: number;
  endTime: number;
}

export interface FundingRateHistoryPercent {
  symbol: string;
  fundingRatePercent: number;
  fundingTime: number;
  markPrice: number | null;
}

/** Maker/taker trading fee, in PERCENT (never a fraction, never basis points). */
export interface FeeRatePercent {
  makerPercent: number;
  takerPercent: number;
}

export type PositionAbsenceReason = 'no_record' | 'zero_contracts' | 'fetch_error';

export type PositionAmbiguityReason = 'side_mismatch' | 'idx_mismatch';

export type PositionStateResult =
  | { kind: 'present'; position: Position }
  | { kind: 'absent'; confidence: 'confirmed' | 'unconfirmed'; reason: PositionAbsenceReason; errorText?: string; positionUpdatedAtMs?: number }
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
  beforeOrder?: () => Promise<void>;
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
  timeInForce?: TimeInForceEnum;
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
  /** Default «до отмены» (GTC); `PostOnly` — only as a maker. */
  timeInForce?: TimeInForceEnum;
  beforeOrder?: () => Promise<void>;
}

export interface OpenPositionLimitWithLeverageArgs extends OpenPositionLimitArgs {
  leverage: number;
}

export interface OpenPositionMarketArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  leverage?: number;
  marginMode?: MarginModeEnum;
  clientOrderId?: string;
  beforeOrder?: () => Promise<void>;
}

export interface ClosePositionLimitArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  price: number;
  clientOrderId?: string;
  /** Default «до отмены» (GTC); `PostOnly` — only as a maker. */
  timeInForce?: TimeInForceEnum;
  beforeOrder?: () => Promise<void>;
}

export interface ClosePositionMarketArgs {
  symbol: string;
  marketType: MarketTypeEnum;
  direction: Direction;
  amount: number;
  clientOrderId?: string;
  beforeOrder?: () => Promise<void>;
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
  beforeOrder?: () => Promise<void>;
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
  beforeOrder?: () => Promise<void>;
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
  beforeOrder?: () => Promise<void>;
}

export interface PositionManagerAddIsolatedPositionMarginArgs {
  symbol: string;
  direction: Direction;
  amount: number;
}

export interface SetLeverageArgs {
  symbol: string;
  leverage: number;
  direction?: Direction;
}

export interface SetPositionModeArgs {
  mode: PositionModeEnum;
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
  /** Applies to every item; default «до отмены» (GTC). */
  timeInForce?: TimeInForceEnum;
  /** Runs once, after the queue and right before the whole batch is sent. */
  beforeOrder?: () => Promise<void>;
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
  /** Applies to every item; default «до отмены» (GTC). */
  timeInForce?: TimeInForceEnum;
  /** Runs once, after the queue and right before the whole batch is sent. */
  beforeOrder?: () => Promise<void>;
}

export interface PositionBatchLimitItemResult {
  isSuccess: boolean;
  orderId: string | null;
  errorText: string | null;
}

export type OpenPositionBatchLimitResult = PositionBatchLimitItemResult[];

export type ClosePositionBatchLimitResult = PositionBatchLimitItemResult[];
