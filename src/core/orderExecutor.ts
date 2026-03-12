import { logger } from './logger';
import { OrderCalculator } from './orderCalculator';

import {
  CloseOrderResult,
  CreateCloseOrderArgs,
  CreateOrderArgs,
  OrderResult,
  OrderTypeEnum,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isOrderSuccessful, isSpot } from '../utils/order.utils';

export class OrderExecutor {
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
    let closeOrderParams = OrderCalculator.calculateCloseOrder(
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
