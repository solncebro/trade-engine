import { logger } from './logger';
import { OrderCalculator } from './orderCalculator';

import {
  CloseOrderResult,
  CreateCloseOrderArgs,
  CreateOrderArgs,
  OrderResult,
} from '../types';
import { formatErrorMessage } from '../utils/errorFormatter.utils';
import { isOrderSuccessful } from '../utils/order.utils';

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
    const { exchangeConnector, orderParams, priceShiftPercent, isTakeProfit } =
      args;
    const closeOrderParams = OrderCalculator.calculateCloseOrder(
      orderParams,
      priceShiftPercent,
      isTakeProfit
    );

    const orderTypeText = isTakeProfit ? 'take profit' : 'stop loss';

    logger.info(
      {
        closeOrderParams,
        tickerPrice: orderParams.price,
        priceShiftPercent,
        isTakeProfit,
      },
      `Creating ${orderTypeText} order`
    );

    const result = await this.createOrder({
      exchangeConnector,
      orderParams: closeOrderParams,
    });

    if (isOrderSuccessful(result)) {
      const capitalizedOrderTypeText =
        orderTypeText.charAt(0).toUpperCase() + orderTypeText.slice(1);

      logger.info(
        {
          closeOrderId: result.orderId,
          isTakeProfit,
        },
        `${capitalizedOrderTypeText} order created successfully`
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
