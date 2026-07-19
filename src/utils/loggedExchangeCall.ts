import { logger } from '../core/logger';
import type { ExchangeConnector } from '../services/exchangeConnector';
import type { CancelOrderItemResult, Order } from '../types/index';
import { MarketTypeEnum } from '../types/index';

interface LoggedCancelBatchOrdersArgs {
  exchangeConnector: ExchangeConnector;
  symbol: string;
  orderIdList: string[];
  modulePrefix: string;
  contextLabel: string;
  errorLevel?: 'warn' | 'error';
  metadata?: Record<string, unknown>;
}

interface LoggedCancelBatchOrdersResult {
  isSuccess: boolean;
  itemResultList: CancelOrderItemResult[];
  failedOrderIdList: string[];
  error: unknown;
}

interface LoggedCancelOrderArgs {
  exchangeConnector: ExchangeConnector;
  symbol: string;
  orderId: string;
  modulePrefix: string;
  contextLabel: string;
  errorLevel?: 'warn' | 'error';
  metadata?: Record<string, unknown>;
}

interface LoggedCancelOrderResult {
  isSuccess: boolean;
  error: unknown;
}

async function loggedCancelBatchOrders(args: LoggedCancelBatchOrdersArgs): Promise<LoggedCancelBatchOrdersResult> {
  const { exchangeConnector, symbol, orderIdList, modulePrefix, contextLabel, errorLevel = 'error', metadata = {} } = args;
  const count = orderIdList.length;

  logger.info(
    { symbol, orderIdList, ...metadata },
    `${modulePrefix} ${symbol} cancelBatchOrders request (${contextLabel}) count=${count}`,
  );

  try {
    const itemResultList = await exchangeConnector.positionManager.cancelBatchOrders({
      symbol,
      marketType: MarketTypeEnum.Futures,
      orderIdList,
    });

    const failedOrderIdList = itemResultList.filter((item) => !item.isSuccess).map((item) => item.orderId);
    const successCount = itemResultList.length - failedOrderIdList.length;
    const failureCount = failedOrderIdList.length;
    const isSuccess = failureCount === 0;

    logger.info(
      { symbol, orderIdList, itemResultList, failedOrderIdList, successCount, failureCount, ...metadata },
      `${modulePrefix} ${symbol} cancelBatchOrders response ok (${contextLabel}) success=${successCount} failure=${failureCount} count=${itemResultList.length}`,
    );

    if (failureCount > 0) {
      logger.warn(
        { symbol, failedOrderIdList, itemResultList, ...metadata },
        `${modulePrefix} ${symbol} Partial batch cancel — ${failureCount} orders not cancelled (${contextLabel}): orderIdList=${JSON.stringify(failedOrderIdList)}`,
      );
    }

    return { isSuccess, itemResultList, failedOrderIdList, error: null };
  } catch (error: unknown) {
    const errorLogger = errorLevel === 'warn' ? logger.warn.bind(logger) : logger.error.bind(logger);

    errorLogger(
      { error, symbol, orderIdList, ...metadata },
      `${modulePrefix} ${symbol} cancelBatchOrders failed (${contextLabel})`,
    );

    return { isSuccess: false, itemResultList: [], failedOrderIdList: [...orderIdList], error };
  }
}

async function loggedCancelOrder(args: LoggedCancelOrderArgs): Promise<LoggedCancelOrderResult> {
  const { exchangeConnector, symbol, orderId, modulePrefix, contextLabel, errorLevel = 'error', metadata = {} } = args;

  logger.info(
    { symbol, orderId, ...metadata },
    `${modulePrefix} ${symbol} cancelOrder request (${contextLabel}) orderId=${orderId}`,
  );

  try {
    await exchangeConnector.positionManager.cancelOrder({
      symbol,
      marketType: MarketTypeEnum.Futures,
      orderId,
    });

    logger.info(
      { symbol, orderId, ...metadata },
      `${modulePrefix} ${symbol} cancelOrder response ok (${contextLabel}) orderId=${orderId}`,
    );

    return { isSuccess: true, error: null };
  } catch (error: unknown) {
    const errorLogger = errorLevel === 'warn' ? logger.warn.bind(logger) : logger.error.bind(logger);

    errorLogger(
      { error, symbol, orderId, ...metadata },
      `${modulePrefix} ${symbol} cancelOrder failed (${contextLabel}) orderId=${orderId}`,
    );

    return { isSuccess: false, error };
  }
}

interface LoggedGetOrderArgs {
  exchangeConnector: ExchangeConnector;
  symbol: string;
  orderId: string;
  modulePrefix: string;
  contextLabel: string;
  errorLevel?: 'warn' | 'error';
  metadata?: Record<string, unknown>;
}

interface LoggedGetOrderResult {
  order: Order | null;
  error: unknown;
}

async function loggedGetOrder(args: LoggedGetOrderArgs): Promise<LoggedGetOrderResult> {
  const { exchangeConnector, symbol, orderId, modulePrefix, contextLabel, errorLevel = 'warn', metadata = {} } = args;

  logger.info(
    { symbol, orderId, ...metadata },
    `${modulePrefix} ${symbol} getOrder request (${contextLabel}) orderId=${orderId}`,
  );

  try {
    const order = await exchangeConnector.futures.getOrder(symbol, orderId);

    logger.info(
      { symbol, orderId, orderStatus: order?.status, order, ...metadata },
      `${modulePrefix} ${symbol} getOrder response (${contextLabel}) status=${order?.status} orderId=${orderId}`,
    );

    return { order: order ?? null, error: null };
  } catch (error: unknown) {
    const errorLogger = errorLevel === 'warn' ? logger.warn.bind(logger) : logger.error.bind(logger);

    errorLogger(
      { error, symbol, orderId, ...metadata },
      `${modulePrefix} ${symbol} getOrder failed (${contextLabel}) orderId=${orderId}`,
    );

    return { order: null, error };
  }
}

export { loggedCancelBatchOrders, loggedCancelOrder, loggedGetOrder };
export type {
  LoggedCancelBatchOrdersArgs,
  LoggedCancelBatchOrdersResult,
  LoggedCancelOrderArgs,
  LoggedCancelOrderResult,
  LoggedGetOrderArgs,
  LoggedGetOrderResult,
};
