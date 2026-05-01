import {
  ExchangeNameEnum,
  MarketTypeEnum,
  MarketUnitEnum,
  OrderFilterEnum,
  OrderSideEnum,
  OrderTypeEnum,
  PositionModeEnum,
  PositionSideEnum,
  TriggerByEnum,
  WorkingTypeEnum,
} from '@solncebro/exchange-engine';

import { logger } from './logger';
import {
  ApplyFuturesSetupArgs,
  BuildOrderParamsInput,
  CancelBatchOrdersArgs,
  CancelOrderArgs,
  ClosePositionLimitArgs,
  ClosePositionMarketArgs,
  Direction,
  OpenPositionLimitArgs,
  OpenPositionMarketArgs,
  PlaceConditionalArgs,
  PlaceStopLossArgs,
  PlaceTakeProfitArgs,
  SetLeverageArgs,
  SetMarginModeArgs,
  SpotMarketBuyByQuoteArgs,
  StopOrderType,
} from './positionManager.types';

import { ExchangeConnector } from '../services/exchangeConnector';
import { OrderParams, OrderResult } from '../types/orders';

const SPOT_SHORT_ERROR_MESSAGE =
  'SHORT positions are not supported on spot. Use marketType=Futures.';

export class PositionManager {
  constructor(private readonly exchangeConnector: ExchangeConnector) {}

  public async openPositionLimit(args: OpenPositionLimitArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);
    await this.applyFuturesSetup({
      marketType: args.marketType,
      symbol: args.symbol,
      leverage: args.leverage,
      marginMode: args.marginMode,
    });

    const orderParams = this.buildOrderParams({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      side: this.directionToOpenSide(args.direction),
      amount: args.amount,
      price: args.price,
      type: OrderTypeEnum.Limit,
      isReduceOnly: false,
      clientOrderId: args.clientOrderId,
    });

    return this.exchangeConnector.createOrder(orderParams);
  }

  public async openPositionMarket(args: OpenPositionMarketArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);
    await this.applyFuturesSetup({
      marketType: args.marketType,
      symbol: args.symbol,
      leverage: args.leverage,
      marginMode: args.marginMode,
    });

    const orderParams = this.buildOrderParams({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      side: this.directionToOpenSide(args.direction),
      amount: args.amount,
      price: 0,
      type: OrderTypeEnum.Market,
      isReduceOnly: false,
      clientOrderId: args.clientOrderId,
    });

    return this.exchangeConnector.createOrder(orderParams);
  }

  public async closePositionLimit(args: ClosePositionLimitArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);

    const orderParams = this.buildOrderParams({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      side: this.directionToCloseSide(args.direction),
      amount: args.amount,
      price: args.price,
      type: OrderTypeEnum.Limit,
      isReduceOnly: true,
      clientOrderId: args.clientOrderId,
    });

    return this.exchangeConnector.createOrder(orderParams);
  }

  public async closePositionMarket(args: ClosePositionMarketArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);

    const orderParams = this.buildOrderParams({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      side: this.directionToCloseSide(args.direction),
      amount: args.amount,
      price: 0,
      type: OrderTypeEnum.Market,
      isReduceOnly: true,
      clientOrderId: args.clientOrderId,
    });

    return this.exchangeConnector.createOrder(orderParams);
  }

  public async placeStopLoss(args: PlaceStopLossArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);
    return this.placeConditional({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      triggerPrice: args.triggerPrice,
      amount: args.amount,
      triggerBy: args.triggerBy,
      orderType: args.orderType,
      limitPrice: args.limitPrice,
      clientOrderId: args.clientOrderId,
      isStopLoss: true,
    });
  }

  public async placeTakeProfit(args: PlaceTakeProfitArgs): Promise<OrderResult> {
    this.assertSpotDirection(args.marketType, args.direction);
    return this.placeConditional({
      symbol: args.symbol,
      marketType: args.marketType,
      direction: args.direction,
      triggerPrice: args.triggerPrice,
      amount: args.amount,
      triggerBy: args.triggerBy,
      orderType: args.orderType,
      limitPrice: args.limitPrice,
      clientOrderId: args.clientOrderId,
      isStopLoss: false,
    });
  }

  public async cancelOrder(args: CancelOrderArgs): Promise<void> {
    const client = this.exchangeConnector.getClient(args.marketType);
    logger.info(
      { symbol: args.symbol, orderId: args.orderId, marketType: args.marketType },
      `[PositionManager] ${args.symbol} cancelOrder request orderId=${args.orderId} marketType=${args.marketType}`
    );
    await client.cancelOrder(args.symbol, args.orderId);
    logger.info(
      { symbol: args.symbol, orderId: args.orderId, marketType: args.marketType },
      `[PositionManager] ${args.symbol} cancelOrder response ok orderId=${args.orderId}`
    );
  }

  public async cancelBatchOrders(args: CancelBatchOrdersArgs): Promise<void> {
    if (args.orderIdList.length === 0) {
      return;
    }
    const client = this.exchangeConnector.getClient(args.marketType);
    logger.info(
      { symbol: args.symbol, orderIdList: args.orderIdList, marketType: args.marketType, count: args.orderIdList.length },
      `[PositionManager] ${args.symbol} cancelBatchOrders request count=${args.orderIdList.length} marketType=${args.marketType}`
    );
    await client.cancelBatchOrders(args.symbol, args.orderIdList);
    logger.info(
      { symbol: args.symbol, orderIdList: args.orderIdList, marketType: args.marketType, count: args.orderIdList.length },
      `[PositionManager] ${args.symbol} cancelBatchOrders response ok count=${args.orderIdList.length}`
    );
  }

  public async spotMarketBuyByQuote(args: SpotMarketBuyByQuoteArgs): Promise<OrderResult> {
    if (args.quoteAmount <= 0 || !Number.isFinite(args.quoteAmount)) {
      throw new Error(
        `spotMarketBuyByQuote requires positive quoteAmount, got ${args.quoteAmount} for ${args.symbol}`
      );
    }

    const orderParams: OrderParams = {
      symbol: args.symbol,
      side: OrderSideEnum.Buy,
      amount: 0,
      price: 0,
      type: OrderTypeEnum.Market,
      marketType: MarketTypeEnum.Spot,
      quoteOrderQty: args.quoteAmount,
      clientOrderId: args.clientOrderId,
    };

    if (this.exchangeConnector.getExchangeName() === ExchangeNameEnum.Bybit) {
      orderParams.marketUnit = MarketUnitEnum.QuoteCoin;
    }

    return this.exchangeConnector.createOrder(orderParams);
  }

  public async setLeverage(args: SetLeverageArgs): Promise<void> {
    await this.exchangeConnector.futures.setLeverage(args.leverage, args.symbol);
  }

  public async setMarginMode(args: SetMarginModeArgs): Promise<void> {
    await this.exchangeConnector.futures.setMarginMode(args.marginMode, args.symbol);
  }

  private async placeConditional(args: PlaceConditionalArgs): Promise<OrderResult> {
    const isSpot = args.marketType === MarketTypeEnum.Spot;
    const orderType: StopOrderType = args.orderType ?? 'Market';
    const exchangeOrderType = this.resolveConditionalOrderType(orderType, args.isStopLoss);

    const side = this.directionToCloseSide(args.direction);
    const price = orderType === 'Limit' && args.limitPrice !== undefined ? args.limitPrice : 0;

    const orderParams: OrderParams = {
      symbol: args.symbol,
      side,
      amount: args.amount,
      price,
      type: exchangeOrderType,
      marketType: args.marketType,
      triggerPrice: args.triggerPrice,
      clientOrderId: args.clientOrderId,
    };

    if (isSpot) {
      orderParams.orderFilter = OrderFilterEnum.StopOrder;
    } else {
      const exchangeName = this.exchangeConnector.getExchangeName();

      orderParams.triggerBy = args.triggerBy ?? TriggerByEnum.MarkPrice;

      if (exchangeName === ExchangeNameEnum.Bybit) {
        orderParams.triggerDirection = this.resolveTriggerDirection(args.direction, args.isStopLoss);
        orderParams.closeOnTrigger = true;
      }

      if (exchangeName === ExchangeNameEnum.Binance) {
        orderParams.workingType = this.mapTriggerByToWorkingType(orderParams.triggerBy);
      }

      const isHedge = this.exchangeConnector.futuresPositionMode === PositionModeEnum.Hedge;

      if (isHedge) {
        orderParams.positionSide = this.directionToPositionSide(args.direction);
        if (exchangeName !== ExchangeNameEnum.Binance) {
          orderParams.reduceOnly = true;
        }
      } else {
        orderParams.reduceOnly = true;
        if (exchangeName === ExchangeNameEnum.Bybit) {
          orderParams.positionSide = undefined;
        }
      }
    }

    return this.exchangeConnector.createOrder(orderParams);
  }

  private buildOrderParams(input: BuildOrderParamsInput): OrderParams {
    const isSpot = input.marketType === MarketTypeEnum.Spot;
    const orderParams: OrderParams = {
      symbol: input.symbol,
      side: input.side,
      amount: input.amount,
      price: input.price,
      type: input.type,
      marketType: input.marketType,
      clientOrderId: input.clientOrderId,
    };

    if (isSpot) {
      return orderParams;
    }

    const exchangeName = this.exchangeConnector.getExchangeName();
    const isHedge = this.exchangeConnector.futuresPositionMode === PositionModeEnum.Hedge;

    if (isHedge) {
      orderParams.positionSide = this.directionToPositionSide(input.direction);

      if (input.isReduceOnly && exchangeName !== ExchangeNameEnum.Binance) {
        orderParams.reduceOnly = true;
      }
    } else if (input.isReduceOnly) {
      orderParams.reduceOnly = true;
    }

    return orderParams;
  }

  private async applyFuturesSetup(args: ApplyFuturesSetupArgs): Promise<void> {
    if (args.marketType !== MarketTypeEnum.Futures) {
      return;
    }

    if (args.leverage !== undefined) {
      await this.exchangeConnector.futures.setLeverage(args.leverage, args.symbol);
    }

    if (args.marginMode !== undefined) {
      await this.exchangeConnector.futures.setMarginMode(args.marginMode, args.symbol);
    }
  }

  private assertSpotDirection(marketType: MarketTypeEnum, direction: Direction): void {
    if (marketType === MarketTypeEnum.Spot && direction === 'short') {
      throw new Error(SPOT_SHORT_ERROR_MESSAGE);
    }
  }

  private directionToOpenSide(direction: Direction): OrderSideEnum {
    return direction === 'long' ? OrderSideEnum.Buy : OrderSideEnum.Sell;
  }

  private directionToCloseSide(direction: Direction): OrderSideEnum {
    return direction === 'long' ? OrderSideEnum.Sell : OrderSideEnum.Buy;
  }

  private directionToPositionSide(direction: Direction): PositionSideEnum {
    return direction === 'long' ? PositionSideEnum.Long : PositionSideEnum.Short;
  }

  private resolveTriggerDirection(direction: Direction, isStopLoss: boolean): 1 | 2 {
    if (isStopLoss) {
      return direction === 'long' ? 2 : 1;
    }
    return direction === 'long' ? 1 : 2;
  }

  private resolveConditionalOrderType(orderType: StopOrderType, isStopLoss: boolean): OrderTypeEnum {
    if (isStopLoss) {
      return orderType === 'Market' ? OrderTypeEnum.StopMarket : OrderTypeEnum.StopLimit;
    }
    return orderType === 'Market' ? OrderTypeEnum.TakeProfitMarket : OrderTypeEnum.TakeProfitLimit;
  }

  private mapTriggerByToWorkingType(triggerBy: TriggerByEnum): WorkingTypeEnum {
    if (triggerBy === TriggerByEnum.MarkPrice) {
      return WorkingTypeEnum.MarkPrice;
    }
    return WorkingTypeEnum.ContractPrice;
  }
}
