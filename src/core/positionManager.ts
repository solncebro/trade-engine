import {
  CancelBatchOrdersResult,
  ExchangeNameEnum,
  MarketTypeEnum,
  MarketUnitEnum,
  ModifyBatchOrderArgs,
  ModifyBatchOrdersResult,
  Order,
  OrderFilterEnum,
  OrderSideEnum,
  OrderTypeEnum,
  Position,
  PositionModeEnum,
  PositionSideEnum,
  TriggerByEnum,
} from '@solncebro/exchange-engine';

import { logger } from './logger';
import { LogThrottle } from './logThrottle';
import {
  ApplyFuturesSetupArgs,
  BuildOrderParamsInput,
  CancelAllOrdersArgs,
  CancelBatchOrdersArgs,
  CancelOrderArgs,
  ClosePositionBatchLimitArgs,
  ClosePositionBatchLimitResult,
  ClosePositionLimitArgs,
  ClosePositionMarketArgs,
  Direction,
  OpenPositionBatchLimitArgs,
  OpenPositionBatchLimitResult,
  OpenPositionLimitArgs,
  OpenPositionMarketArgs,
  PlaceConditionalArgs,
  PlaceStopLossArgs,
  PlaceTakeProfitArgs,
  PositionBatchLimitItemResult,
  PositionManagerModifyBatchOrdersArgs,
  PositionManagerModifyOrderArgs,
  PositionStateResult,
  ReadAllPositionsArgs,
  ReadPositionStateArgs,
  SetLeverageArgs,
  SetMarginModeArgs,
  SpotMarketBuyByQuoteArgs,
  StopOrderType,
} from './positionManager.types';
import { RateLimitedRequestQueue } from './RateLimitedRequestQueue';
import { withRetryOn429 } from './withRetryOn429';

import { ExchangeConnector } from '../services/exchangeConnector';
import { OrderParams, OrderResult } from '../types/orders';

const SPOT_SHORT_ERROR_MESSAGE =
  'SHORT positions are not supported on spot. Use marketType=Futures.';

// readPositionState is called on every PnL poll tick (~15s per position). The
// snapshot response log is throttled per symbol so a stable position does not
// emit a line every poll; errors and app-level per-consumer logs are unaffected.
const READ_POSITION_STATE_LOG_THROTTLE_MS = 300_000;

export class PositionManager {
  private readonly explicitQueue: RateLimitedRequestQueue | null;
  private readonly readStateLogThrottle: LogThrottle = new LogThrottle();

  constructor(
    private readonly exchangeConnector: ExchangeConnector,
    queue?: RateLimitedRequestQueue
  ) {
    this.explicitQueue = queue ?? null;
  }

  private resolveWriteQueue(): RateLimitedRequestQueue | null {
    if (this.explicitQueue !== null) {
      return this.explicitQueue;
    }

    return this.exchangeConnector.getWriteQueue();
  }

  private executeWrite<T>(fn: () => Promise<T>, contextLabel: string): Promise<T> {
    const queue = this.resolveWriteQueue();

    if (queue === null) {
      return fn();
    }

    return queue.execute(fn, contextLabel);
  }

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

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `openPositionLimit ${args.symbol}`
    );
  }

  public async openPositionBatchLimit(args: OpenPositionBatchLimitArgs): Promise<OpenPositionBatchLimitResult> {
    if (args.itemList.length === 0) {
      return [];
    }

    for (const item of args.itemList) {
      this.assertSpotDirection(args.marketType, item.direction);
    }

    await this.applyFuturesSetup({
      marketType: args.marketType,
      symbol: args.symbol,
      leverage: args.leverage,
      marginMode: args.marginMode,
    });

    const orderParamsList = args.itemList.map(item =>
      this.buildOrderParams({
        symbol: args.symbol,
        marketType: args.marketType,
        direction: item.direction,
        side: this.directionToOpenSide(item.direction),
        amount: item.amount,
        price: item.price,
        type: OrderTypeEnum.Limit,
        isReduceOnly: false,
        clientOrderId: item.clientOrderId,
      })
    );

    logger.info(
      { symbol: args.symbol, marketType: args.marketType, count: args.itemList.length },
      `[PositionManager] ${args.symbol} openPositionBatchLimit request count=${args.itemList.length} marketType=${args.marketType}`
    );

    const orderResultList = await this.executeWrite(
      () => this.exchangeConnector.createBatchOrders(orderParamsList),
      `openPositionBatchLimit ${args.symbol} count=${args.itemList.length}`
    );

    const itemResultList: OpenPositionBatchLimitResult = orderResultList.map(
      (orderResult): PositionBatchLimitItemResult => ({
        isSuccess: orderResult.orderId !== undefined && orderResult.orderId !== '' && orderResult.errorText === undefined,
        orderId: orderResult.orderId !== undefined && orderResult.orderId !== '' ? orderResult.orderId : null,
        errorText: orderResult.errorText ?? null,
      })
    );

    const successCount = itemResultList.filter(item => item.isSuccess).length;
    const failureCount = itemResultList.length - successCount;
    logger.info(
      {
        symbol: args.symbol,
        marketType: args.marketType,
        count: args.itemList.length,
        successCount,
        failureCount,
      },
      `[PositionManager] ${args.symbol} openPositionBatchLimit response success=${successCount} failure=${failureCount} count=${itemResultList.length}`
    );

    return itemResultList;
  }

  public async closePositionBatchLimit(args: ClosePositionBatchLimitArgs): Promise<ClosePositionBatchLimitResult> {
    if (args.itemList.length === 0) {
      return [];
    }

    for (const item of args.itemList) {
      this.assertSpotDirection(args.marketType, item.direction);
    }

    const orderParamsList = args.itemList.map(item =>
      this.buildOrderParams({
        symbol: args.symbol,
        marketType: args.marketType,
        direction: item.direction,
        side: this.directionToCloseSide(item.direction),
        amount: item.amount,
        price: item.price,
        type: OrderTypeEnum.Limit,
        isReduceOnly: true,
        clientOrderId: item.clientOrderId,
      })
    );

    logger.info(
      { symbol: args.symbol, marketType: args.marketType, count: args.itemList.length },
      `[PositionManager] ${args.symbol} closePositionBatchLimit request count=${args.itemList.length} marketType=${args.marketType}`
    );

    const orderResultList = await this.executeWrite(
      () => this.exchangeConnector.createBatchOrders(orderParamsList),
      `closePositionBatchLimit ${args.symbol} count=${args.itemList.length}`
    );

    const itemResultList: ClosePositionBatchLimitResult = orderResultList.map(
      (orderResult): PositionBatchLimitItemResult => ({
        isSuccess: orderResult.orderId !== undefined && orderResult.orderId !== '' && orderResult.errorText === undefined,
        orderId: orderResult.orderId !== undefined && orderResult.orderId !== '' ? orderResult.orderId : null,
        errorText: orderResult.errorText ?? null,
      })
    );

    const successCount = itemResultList.filter(item => item.isSuccess).length;
    const failureCount = itemResultList.length - successCount;
    logger.info(
      {
        symbol: args.symbol,
        marketType: args.marketType,
        count: args.itemList.length,
        successCount,
        failureCount,
      },
      `[PositionManager] ${args.symbol} closePositionBatchLimit response success=${successCount} failure=${failureCount} count=${itemResultList.length}`
    );

    return itemResultList;
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

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `openPositionMarket ${args.symbol}`
    );
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

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `closePositionLimit ${args.symbol}`
    );
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

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `closePositionMarket ${args.symbol}`
    );
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
    await this.executeWrite(
      () => withRetryOn429({
        fn: () => client.cancelOrder(args.symbol, args.orderId),
        contextLabel: `cancelOrder ${args.symbol} orderId=${args.orderId}`,
      }),
      `cancelOrder ${args.symbol}`
    );
    logger.info(
      { symbol: args.symbol, orderId: args.orderId, marketType: args.marketType },
      `[PositionManager] ${args.symbol} cancelOrder response ok orderId=${args.orderId}`
    );
  }

  public async cancelBatchOrders(args: CancelBatchOrdersArgs): Promise<CancelBatchOrdersResult> {
    if (args.orderIdList.length === 0) {
      return [];
    }
    const client = this.exchangeConnector.getClient(args.marketType);
    logger.info(
      { symbol: args.symbol, orderIdList: args.orderIdList, marketType: args.marketType, count: args.orderIdList.length },
      `[PositionManager] ${args.symbol} cancelBatchOrders request count=${args.orderIdList.length} marketType=${args.marketType}`
    );

    const result = await this.executeWrite(
      () => withRetryOn429({
        fn: () => client.cancelBatchOrders(args.symbol, args.orderIdList),
        contextLabel: `cancelBatchOrders ${args.symbol} count=${args.orderIdList.length}`,
      }),
      `cancelBatchOrders ${args.symbol}`
    );

    const successCount = result.filter(item => item.isSuccess).length;
    const failureCount = result.length - successCount;
    logger.info(
      {
        symbol: args.symbol,
        orderIdList: args.orderIdList,
        marketType: args.marketType,
        count: args.orderIdList.length,
        result,
        successCount,
        failureCount,
      },
      `[PositionManager] ${args.symbol} cancelBatchOrders response success=${successCount} failure=${failureCount} count=${result.length}`
    );

    return result;
  }

  public async cancelAllOrders(args: CancelAllOrdersArgs): Promise<void> {
    const client = this.exchangeConnector.getClient(args.marketType);
    logger.info(
      { symbol: args.symbol, marketType: args.marketType },
      `[PositionManager] ${args.symbol} cancelAllOrders request marketType=${args.marketType}`
    );
    await this.executeWrite(
      () => withRetryOn429({
        fn: () => client.cancelAllOrders(args.symbol),
        contextLabel: `cancelAllOrders ${args.symbol}`,
      }),
      `cancelAllOrders ${args.symbol}`
    );
    logger.info(
      { symbol: args.symbol, marketType: args.marketType },
      `[PositionManager] ${args.symbol} cancelAllOrders response ok`
    );
  }

  public async modifyOrder(args: PositionManagerModifyOrderArgs): Promise<Order> {
    const client = this.exchangeConnector.getClient(args.marketType);
    logger.info(
      {
        symbol: args.symbol,
        orderId: args.orderId,
        marketType: args.marketType,
        price: args.price,
        amount: args.amount,
        triggerPrice: args.triggerPrice,
      },
      `[PositionManager] ${args.symbol} modifyOrder request orderId=${args.orderId} marketType=${args.marketType}`
    );

    const result = await this.executeWrite(
      () => withRetryOn429({
        fn: () => client.modifyOrder({
          symbol: args.symbol,
          orderId: args.orderId,
          price: args.price,
          amount: args.amount,
          triggerPrice: args.triggerPrice,
        }),
        contextLabel: `modifyOrder ${args.symbol} orderId=${args.orderId}`,
      }),
      `modifyOrder ${args.symbol}`
    );

    logger.info(
      { symbol: args.symbol, orderId: args.orderId, marketType: args.marketType, resultOrderId: result.id },
      `[PositionManager] ${args.symbol} modifyOrder response ok orderId=${args.orderId}`
    );

    return result;
  }

  public async modifyBatchOrders(
    args: PositionManagerModifyBatchOrdersArgs
  ): Promise<ModifyBatchOrdersResult> {
    if (args.orderList.length === 0) {
      return [];
    }

    const client = this.exchangeConnector.getClient(args.marketType);
    const exchangeArgsList: ModifyBatchOrderArgs[] = args.orderList.map(item => ({
      symbol: item.symbol,
      orderId: item.orderId,
      side: item.side,
      price: item.price,
      amount: item.amount,
      triggerPrice: item.triggerPrice,
      clientOrderId: item.clientOrderId,
    }));

    logger.info(
      { marketType: args.marketType, count: args.orderList.length },
      `[PositionManager] modifyBatchOrders request count=${args.orderList.length} marketType=${args.marketType}`
    );

    const result = await this.executeWrite(
      () => withRetryOn429({
        fn: () => client.modifyBatchOrders(exchangeArgsList),
        contextLabel: `modifyBatchOrders ${args.marketType} count=${args.orderList.length}`,
      }),
      `modifyBatchOrders ${args.marketType}`
    );

    const successCount = result.filter(item => item.isSuccess).length;
    const failureCount = result.length - successCount;
    logger.info(
      {
        marketType: args.marketType,
        count: args.orderList.length,
        result,
        successCount,
        failureCount,
      },
      `[PositionManager] modifyBatchOrders response success=${successCount} failure=${failureCount} count=${result.length}`
    );

    return result;
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

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `spotMarketBuyByQuote ${args.symbol}`
    );
  }

  public async setLeverage(args: SetLeverageArgs): Promise<void> {
    logger.info(
      { symbol: args.symbol, leverage: args.leverage },
      `[PositionManager] ${args.symbol} setLeverage request leverage=${args.leverage}`
    );
    await this.executeWrite(
      () => withRetryOn429({
        fn: () => this.exchangeConnector.futures.setLeverage(args.leverage, args.symbol),
        contextLabel: `setLeverage ${args.symbol} leverage=${args.leverage}`,
      }),
      `setLeverage ${args.symbol}`
    );
    logger.info(
      { symbol: args.symbol, leverage: args.leverage },
      `[PositionManager] ${args.symbol} setLeverage response ok leverage=${args.leverage}`
    );
  }

  public async setMarginMode(args: SetMarginModeArgs): Promise<void> {
    logger.info(
      { symbol: args.symbol, marginMode: args.marginMode },
      `[PositionManager] ${args.symbol} setMarginMode request marginMode=${args.marginMode}`
    );
    await this.executeWrite(
      () => withRetryOn429({
        fn: () => this.exchangeConnector.futures.setMarginMode(args.marginMode, args.symbol),
        contextLabel: `setMarginMode ${args.symbol} marginMode=${args.marginMode}`,
      }),
      `setMarginMode ${args.symbol}`
    );
    logger.info(
      { symbol: args.symbol, marginMode: args.marginMode },
      `[PositionManager] ${args.symbol} setMarginMode response ok marginMode=${args.marginMode}`
    );
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
      // Дальше — только НАМЕРЕНИЕ, без единого упоминания конкретной биржи.
      // По какой цене сверять срабатывание; с какой стороны цена подходит к уровню; надо ли
      // при срабатывании закрывать позицию; где «только уменьшить» несовместимо с хеджевым
      // режимом — всё это выводит и решает биржевой слой, каждая биржа у себя.
      orderParams.triggerBy = args.triggerBy ?? TriggerByEnum.MarkPrice;
      orderParams.reduceOnly = true;

      if (this.exchangeConnector.futuresPositionMode === PositionModeEnum.Hedge) {
        orderParams.positionSide = this.directionToPositionSide(args.direction);
      }
    }

    return this.executeWrite(
      () => this.exchangeConnector.createOrder(orderParams),
      `placeConditional ${args.symbol} isStopLoss=${args.isStopLoss}`
    );
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
      await this.setLeverage({ symbol: args.symbol, leverage: args.leverage });
    }

    if (args.marginMode !== undefined) {
      await this.setMarginMode({ symbol: args.symbol, marginMode: args.marginMode });
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

  private resolveConditionalOrderType(orderType: StopOrderType, isStopLoss: boolean): OrderTypeEnum {
    if (isStopLoss) {
      return orderType === 'Market' ? OrderTypeEnum.StopMarket : OrderTypeEnum.StopLimit;
    }
    return orderType === 'Market' ? OrderTypeEnum.TakeProfitMarket : OrderTypeEnum.TakeProfitLimit;
  }

  public async readPositionState(args: ReadPositionStateArgs): Promise<PositionStateResult> {
    const { symbol, marketType, direction } = args;

    if (marketType !== MarketTypeEnum.Futures) {
      throw new Error(`readPositionState supports MarketTypeEnum.Futures only (got ${marketType})`);
    }

    const isHedge = this.exchangeConnector.futuresPositionMode === PositionModeEnum.Hedge;
    const expectedPositionIdx = direction === 'long' ? 1 : 2;
    const expectedSide = direction === 'long' ? PositionSideEnum.Long : PositionSideEnum.Short;
    const positionIdx = isHedge ? expectedPositionIdx : undefined;

    let snapshot: Position | null;

    try {
      snapshot = await this.exchangeConnector.futures.fetchPositionSnapshot(symbol, positionIdx);
      this.readStateLogThrottle.throttled({
        logger,
        level: 'info',
        key: `readPositionState:${symbol}`,
        windowMs: READ_POSITION_STATE_LOG_THROTTLE_MS,
        payload: { symbol, direction, positionIdx, contracts: snapshot?.contracts ?? null, side: snapshot?.side ?? null, snapshotPositionIdx: snapshot?.positionIdx ?? null, entryPrice: snapshot?.entryPrice ?? null },
        message: `[PositionManager] ${symbol} readPositionState fetchPositionSnapshot response contracts=${snapshot?.contracts ?? 'null'} side=${snapshot?.side ?? 'null'} positionIdx=${positionIdx ?? 'any'} direction=${direction}`,
      });
    } catch (error: unknown) {
      const errorText = error instanceof Error ? error.message : String(error);
      logger.warn(
        { symbol, direction, error },
        `[PositionManager] ${symbol} readPositionState fetchPositionSnapshot failed — returning absent/unconfirmed`,
      );

      return { kind: 'absent', confidence: 'unconfirmed', reason: 'fetch_error', errorText };
    }

    if (snapshot === null) {
      return { kind: 'absent', confidence: 'confirmed', reason: 'no_record' };
    }

    if (snapshot.contracts === 0) {
      return { kind: 'absent', confidence: 'confirmed', reason: 'zero_contracts' };
    }

    if (isHedge && snapshot.positionIdx !== undefined && snapshot.positionIdx !== expectedPositionIdx) {
      return { kind: 'ambiguous', reason: 'idx_mismatch', position: snapshot };
    }

    if (isHedge && snapshot.side !== expectedSide) {
      return { kind: 'ambiguous', reason: 'side_mismatch', position: snapshot };
    }

    if (!isHedge && snapshot.side !== PositionSideEnum.Both && snapshot.side !== expectedSide) {
      return { kind: 'ambiguous', reason: 'side_mismatch', position: snapshot };
    }

    return { kind: 'present', position: snapshot };
  }

  public async readAllPositions(args: ReadAllPositionsArgs): Promise<Position[]> {
    const { marketType } = args;

    if (marketType !== MarketTypeEnum.Futures) {
      throw new Error(`readAllPositions supports MarketTypeEnum.Futures only (got ${marketType})`);
    }

    logger.info('[PositionManager] readAllPositions request');

    try {
      const positionList = await this.exchangeConnector.futures.fetchAllPositions();
      logger.info(
        { count: positionList.length },
        `[PositionManager] readAllPositions response count=${positionList.length}`,
      );

      return positionList;
    } catch (error: unknown) {
      logger.warn({ error }, '[PositionManager] readAllPositions failed');
      throw error;
    }
  }
}
