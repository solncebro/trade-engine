import { logger } from './logger';

import {
  ExchangeConnectorByName,
  ExchangeName,
  MarginType,
  OrderAttributes,
  OrderDirection,
  OrderParams,
  OrderType,
  SymbolMappingByExchange,
} from '../types';

interface IterateSymbolMappingByExchangeCallbackArgs {
  exchangeName: ExchangeName;
  originalSymbol: string;
  resolvedSymbol: string;
}

interface IterateSymbolMappingByExchangeArgs {
  symbolMappingByExchange: SymbolMappingByExchange;
  callback: (args: IterateSymbolMappingByExchangeCallbackArgs) => void;
}

interface SetupLeverageAndMarginModeArgs {
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
  leverage: number;
}

interface CreateOrderAttributesForSymbolArgs {
  isLong: boolean;
  exchangeConnectorByName: ExchangeConnectorByName;
  stopBuyAfterPercent: number;
  orderVolumeUsdt: number;
  symbolMappingByExchange: SymbolMappingByExchange;
}

export class OrderCalculator {
  private static addPercent(
    price: number,
    percent: number,
    isIncrease: boolean = true
  ): number {
    const multiplier = 1 + percent / 100;

    return isIncrease ? price * multiplier : price / multiplier;
  }

  private static calculateOrderAmount(
    price: number,
    symbolCount: number,
    orderVolumeUsdt: number
  ): number {
    const volumeUsdtPerSymbol = orderVolumeUsdt / symbolCount;

    return volumeUsdtPerSymbol / price;
  }

  private static getOrderSide(isLong: boolean): OrderDirection {
    return isLong ? OrderDirection.Buy : OrderDirection.Sell;
  }

  private static iterateSymbolMappingByExchange(
    args: IterateSymbolMappingByExchangeArgs
  ): void {
    const { symbolMappingByExchange, callback } = args;

    for (const [
      exchangeName,
      resolvedSymbolBySymbol,
    ] of symbolMappingByExchange) {
      for (const [originalSymbol, resolvedSymbol] of resolvedSymbolBySymbol) {
        callback({
          exchangeName,
          originalSymbol,
          resolvedSymbol,
        });
      }
    }
  }

  private static getUniqueSymbolCountFromMapping(
    symbolMappingByExchange: SymbolMappingByExchange
  ): number {
    const uniqueSymbolSet = new Set<string>();

    OrderCalculator.iterateSymbolMappingByExchange({
      symbolMappingByExchange,
      callback: ({ originalSymbol }) => {
        uniqueSymbolSet.add(originalSymbol);
      },
    });

    return uniqueSymbolSet.size;
  }

  public static resolveSymbolsForExchanges(
    symbolList: string[],
    exchangeConnectorByName: ExchangeConnectorByName
  ): SymbolMappingByExchange {
    const symbolMappingByExchange: SymbolMappingByExchange = new Map();

    for (const symbol of symbolList) {
      for (const [exchangeName, exchangeConnector] of exchangeConnectorByName) {
        const resolvedSymbol =
          exchangeConnector.resolveSymbolWithPrefix(symbol);

        let exchangeMap = symbolMappingByExchange.get(exchangeName);

        if (!exchangeMap) {
          exchangeMap = new Map();
          symbolMappingByExchange.set(exchangeName, exchangeMap);
        }

        exchangeMap.set(symbol, resolvedSymbol);
      }
    }

    return symbolMappingByExchange;
  }

  public static async setupLeverageAndMarginMode(
    args: SetupLeverageAndMarginModeArgs
  ): Promise<void> {
    const { exchangeConnectorByName, symbolMappingByExchange, leverage } = args;
    const setupPromiseList: Promise<void>[] = [];

    OrderCalculator.iterateSymbolMappingByExchange({
      symbolMappingByExchange,
      callback: ({ exchangeName, originalSymbol, resolvedSymbol }) => {
        const exchangeConnector = exchangeConnectorByName.get(exchangeName);

        if (!exchangeConnector) {
          return;
        }

        const setupPromise = (async () => {
          try {
            await Promise.all([
              exchangeConnector.setLeverage(resolvedSymbol, leverage),
              exchangeConnector.setMarginMode(
                resolvedSymbol,
                MarginType.ISOLATED
              ),
            ]);
          } catch (error) {
            logger.warn(
              {
                error,
                symbol: originalSymbol,
                resolvedSymbol,
                exchange: exchangeName,
                leverage,
              },
              'Failed to set leverage and margin mode'
            );
          }
        })();

        setupPromiseList.push(setupPromise);
      },
    });

    await Promise.all(setupPromiseList);
  }

  public static createOrderAttributesForSymbol(
    args: CreateOrderAttributesForSymbolArgs
  ): OrderAttributes[] {
    const {
      isLong,
      exchangeConnectorByName,
      stopBuyAfterPercent,
      orderVolumeUsdt,
      symbolMappingByExchange,
    } = args;
    const uniqueSymbolCount = OrderCalculator.getUniqueSymbolCountFromMapping(
      symbolMappingByExchange
    );
    const orderAttributesList: OrderAttributes[] = [];

    OrderCalculator.iterateSymbolMappingByExchange({
      symbolMappingByExchange,
      callback: ({ exchangeName, originalSymbol, resolvedSymbol }) => {
        const exchangeConnector = exchangeConnectorByName.get(exchangeName);

        if (!exchangeConnector) {
          return;
        }

        const { close: price, percentage } =
          exchangeConnector.getTicker(resolvedSymbol) ?? {};

        const baseOrderParams: OrderParams = {
          symbol: resolvedSymbol,
          side: OrderCalculator.getOrderSide(isLong),
          amount: 0,
          price: price ?? 0,
          type: OrderType.Market,
        };

        const baseOrderParamsWithExchange = {
          orderParams: baseOrderParams,
          exchangeName,
        };

        if (!price) {
          const errorText = `🏷️ No price data available for ${resolvedSymbol} (original: ${originalSymbol}) on ${exchangeName}`;
          logger.warn(
            { symbol: originalSymbol, resolvedSymbol, exchange: exchangeName },
            errorText
          );

          orderAttributesList.push({
            ...baseOrderParamsWithExchange,
            errorText,
          });

          return;
        }

        if (percentage !== undefined && percentage >= stopBuyAfterPercent) {
          const errorText = `📈 Symbol ${resolvedSymbol} (original: ${originalSymbol}) has grown ${percentage.toFixed(2)}% (≥${stopBuyAfterPercent}%) in 24 hours - order creation blocked`;
          logger.warn(
            {
              symbol: originalSymbol,
              resolvedSymbol,
              exchange: exchangeName,
              percentage,
              stopBuyAfterPercent,
            },
            errorText
          );

          orderAttributesList.push({
            ...baseOrderParamsWithExchange,
            errorText,
          });

          return;
        }

        const amount = OrderCalculator.calculateOrderAmount(
          price,
          uniqueSymbolCount,
          orderVolumeUsdt
        );

        orderAttributesList.push({
          ...baseOrderParamsWithExchange,
          orderParams: { ...baseOrderParams, amount },
        });
      },
    });

    return orderAttributesList;
  }

  public static calculateLimitOrderWithPriceAdjustment(
    orderParams: OrderParams,
    priceAdjustmentPercent: number,
    orderVolumeUsdt: number
  ): OrderParams {
    const adjustedPrice = OrderCalculator.addPercent(
      orderParams.price,
      priceAdjustmentPercent
    );
    const adjustedAmount = orderVolumeUsdt / adjustedPrice;

    return {
      ...orderParams,
      type: OrderType.Limit,
      amount: adjustedAmount,
      price: adjustedPrice,
    };
  }

  public static calculateCloseOrder(
    orderParams: OrderParams,
    priceShiftPercent: number,
    isIncrease: boolean
  ): OrderParams {
    const shiftedPrice = OrderCalculator.addPercent(
      orderParams.price,
      priceShiftPercent,
      isIncrease
    );
    const oppositeSide =
      orderParams.side === OrderDirection.Buy
        ? OrderDirection.Sell
        : OrderDirection.Buy;

    return {
      symbol: orderParams.symbol,
      side: oppositeSide,
      amount: orderParams.amount,
      price: shiftedPrice,
      type: OrderType.Limit,
      params: { reduceOnly: true },
    };
  }
}
