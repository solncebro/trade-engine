import { logger } from './logger';

import {
  CloseOrderResult,
  CreateCloseOrderArgs,
  CreateOrderArgs,
  OrderParams,
  OrderResult,
  OrderSideEnum,
  OrderTypeEnum,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isOrderSuccessful, isSpot } from '../utils/order.utils';

export class OrderExecutor {
  // Build the reduce-only close order from an entry: flip side, shift price by the
  // configured percent, and (for stop-loss) attach the trigger. Inlined from the
  // former OrderCalculator.calculateCloseOrder — that listing-domain class has moved
  // out of this shared library; the close-order math is generic and lives here, the
  // sole place it is used.
  private buildCloseOrderParams(
    orderParams: OrderParams,
    priceShiftPercent: number,
    isTakeProfit: boolean
  ): OrderParams {
    const isIncrease = priceShiftPercent > 0;
    const multiplier = 1 + Math.abs(priceShiftPercent) / 100;
    const shiftedPrice = isIncrease
      ? orderParams.price * multiplier
      : orderParams.price / multiplier;
    const oppositeSide =
      orderParams.side === OrderSideEnum.Buy
        ? OrderSideEnum.Sell
        : OrderSideEnum.Buy;

    const baseCloseOrderParams: OrderParams = {
      symbol: orderParams.symbol,
      side: oppositeSide,
      amount: orderParams.amount,
      price: shiftedPrice,
      type: OrderTypeEnum.Limit,
      marketType: orderParams.marketType,
      positionSide: orderParams.positionSide,
    };

    if (!isSpot(orderParams.marketType)) {
      baseCloseOrderParams.params = { reduceOnly: true };
    }

    if (!isTakeProfit) {
      baseCloseOrderParams.triggerPrice = shiftedPrice;
      baseCloseOrderParams.triggerDirection =
        orderParams.side === OrderSideEnum.Buy ? 2 : 1;
    }

    return baseCloseOrderParams;
  }

  protected async createOrder(args: CreateOrderArgs): Promise<OrderResult> {
    const { exchangeConnector, orderParams } = args;
    const exchangeName = exchangeConnector.getExchangeName();

    const orderResultBase = {
      orderParams,
      exchangeName,
    };

    try {
      const orderResult = await exchangeConnector.createOrder(orderParams);

      return orderResult;
    } catch (error) {
      const formattedErrorMessage = formatErrorMessage({
        customMessage: 'Order creation failed',
        error,
      });
      logger.error(
        { error, orderParams, exchange: exchangeName, formattedErrorMessage },
        'Order creation failed'
      );

      return {
        ...orderResultBase,
        errorText: formattedErrorMessage,
      };
    }
  }

  protected async createCloseOrder(
    args: CreateCloseOrderArgs
  ): Promise<CloseOrderResult> {
    const {
      exchangeConnector,
      orderParams,
      priceShiftPercent,
      isTakeProfit,
      isEmergencyExitPosition,
    } = args;
    let closeOrderParams = this.buildCloseOrderParams(
      orderParams,
      priceShiftPercent,
      isTakeProfit
    );

    if (isEmergencyExitPosition) {
      closeOrderParams = {
        ...closeOrderParams,
        type: OrderTypeEnum.Market,
        triggerPrice: undefined,
        triggerDirection: undefined,
      };

      if (!isSpot(closeOrderParams.marketType)) {
        closeOrderParams.params = { reduceOnly: true };
      }
    }

    const regularOrderTypeText = isTakeProfit ? 'take profit' : 'stop loss';
    const orderTypeText = isEmergencyExitPosition
      ? 'emergency exit'
      : regularOrderTypeText;

    logger.info(
      {
        closeOrderParams,
        tickerPrice: orderParams.price,
        priceShiftPercent,
        isTakeProfit,
      },
      `Creating ${orderTypeText} order...`
    );

    const result = await this.createOrder({
      exchangeConnector,
      orderParams: closeOrderParams,
    });

    if (isOrderSuccessful(result)) {
      logger.info(
        {
          closeOrderId: result.orderId,
          isTakeProfit,
        },
        `${orderTypeText} order created successfully`
      );

      return {
        orderId: result.orderId,
        price: closeOrderParams.price,
      };
    }

    const defaultErrorMessage = `Failed to create ${orderTypeText} order`;

    return {
      errorText: result.errorText ?? defaultErrorMessage,
    };
  }
}
