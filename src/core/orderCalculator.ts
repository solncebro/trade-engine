import { logger } from './logger';

import { ExchangeConnector } from '../services/exchangeConnector';
import {
  ExchangeConnectorByName,
  ExchangeNameEnum,
  MarginModeEnum,
  MarketType,
  OrderAttributes,
  OrderParams,
  OrderSideEnum,
  OrderTypeEnum,
  SymbolMappingByExchange,
} from '../types';
import { isSpot } from '../utils/order.utils';

const NO_PRICE_DATA_AVAILABLE = 'No price data available';

interface IterateSymbolMappingByExchangeCallbackArgs {
  exchangeName: ExchangeNameEnum;
  originalSymbol: string;
  resolvedSymbol: string;
}

interface IterateSymbolMappingByExchangeArgs {
  symbolMappingByExchange: SymbolMappingByExchange;
  callback: (args: IterateSymbolMappingByExchangeCallbackArgs) => void;
}

interface SetupLeverageAndMarginModeEnumArgs {
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
  leverage: number;
}

interface BaseOrderCalculationArgs {
  stopBuyAfterPercent: number;
  orderVolumeUsdt: number;
  leverage: number;
  uniqueSymbolCount: number;
}

interface CreateOrderAttributesForSymbolArgs extends BaseOrderCalculationArgs {
  isLong: boolean;
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
}

interface CreateOrderAttributesForMarketTypeArgs extends BaseOrderCalculationArgs {
  exchangeConnector: ExchangeConnector;
  exchangeName: ExchangeNameEnum;
  symbol: string;
  isLong: boolean;
  marketType: MarketType;
}

interface EnrichWithSpotFallbackArgs extends BaseOrderCalculationArgs {
  orderAttributesList: OrderAttributes[];
  exchangeConnectorByName: ExchangeConnectorByName;
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

  private static resolveOrderSideEnum(isLong: boolean): OrderSideEnum {
    return isLong ? OrderSideEnum.Buy : OrderSideEnum.Sell;
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

  public static getUniqueSymbolCountFromMapping(
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

  private static calculateAmountForMarketType(args: {
    price: number;
    orderVolumeUsdt: number;
    uniqueSymbolCount: number;
    leverage: number;
    marketType: MarketType;
  }): number {
    const { price, orderVolumeUsdt, uniqueSymbolCount, leverage, marketType } =
      args;

    const amount = OrderCalculator.calculateOrderAmount(
      price,
      uniqueSymbolCount,
      marketType === MarketType.Spot
        ? orderVolumeUsdt / leverage
        : orderVolumeUsdt
    );

    return amount;
  }

  private static createOrderAttributesForMarketType(
    args: CreateOrderAttributesForMarketTypeArgs
  ): OrderAttributes {
    const {
      exchangeConnector,
      exchangeName,
      symbol,
      isLong,
      stopBuyAfterPercent,
      orderVolumeUsdt,
      uniqueSymbolCount,
      leverage,
      marketType,
    } = args;

    const ticker = exchangeConnector.getTicker(symbol, marketType);
    const price = ticker?.lastPrice;

    const baseOrderParams: OrderParams = {
      symbol,
      side: OrderCalculator.resolveOrderSideEnum(isLong),
      amount: 0,
      price: price ?? 0,
      type: OrderTypeEnum.Market,
      marketType,
    };

    const baseOrderParamsWithExchange: OrderAttributes = {
      orderParams: baseOrderParams,
      exchangeName,
    };

    const marketLabel =
      marketType === MarketType.Spot ? 'on spot ' : 'on futures ';

    if (!price) {
      const errorText = `🏷️ ${NO_PRICE_DATA_AVAILABLE} for ${symbol} ${marketLabel}on ${exchangeName}`;

      logger.warn({ symbol, exchange: exchangeName, marketType }, errorText);

      return {
        ...baseOrderParamsWithExchange,
        errorText,
      };
    }

    if (
      marketType !== MarketType.Spot &&
      ticker.priceChangePercent !== undefined &&
      ticker.priceChangePercent >= stopBuyAfterPercent
    ) {
      const errorText = `📈 Symbol ${symbol} has grown ${ticker.priceChangePercent.toFixed(2)}% (≥${stopBuyAfterPercent}%) in 24 hours on ${marketLabel} - order creation blocked`;

      logger.warn(
        {
          symbol,
          exchange: exchangeName,
          percentage: ticker.priceChangePercent,
          stopBuyAfterPercent,
          marketType,
        },
        errorText
      );

      return {
        ...baseOrderParamsWithExchange,
        errorText,
      };
    }

    const rawAmount = OrderCalculator.calculateAmountForMarketType({
      price,
      orderVolumeUsdt,
      uniqueSymbolCount,
      leverage,
      marketType,
    });

    const amount = parseFloat(
      exchangeConnector.getClient(marketType).amountToPrecision(symbol, rawAmount)
    );

    logger.info(
      {
        symbol,
        exchange: exchangeName,
        price,
        amount,
        marketType,
      },
      `Order attributes created for ${marketType.toUpperCase()}`
    );

    return {
      ...baseOrderParamsWithExchange,
      orderParams: { ...baseOrderParams, amount },
    };
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

  public static async setupLeverageAndMarginModeEnum(
    args: SetupLeverageAndMarginModeEnumArgs
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
              exchangeConnector.setLeverage(
                resolvedSymbol,
                leverage,
                MarketType.Futures
              ),
              exchangeConnector.setMarginMode(
                resolvedSymbol,
                MarginModeEnum.Isolated,
                MarketType.Futures
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
      leverage,
      uniqueSymbolCount,
    } = args;

    const orderAttributesList: OrderAttributes[] = [];

    OrderCalculator.iterateSymbolMappingByExchange({
      symbolMappingByExchange,
      callback: ({ exchangeName, resolvedSymbol }) => {
        const exchangeConnector = exchangeConnectorByName.get(exchangeName);

        if (!exchangeConnector) {
          return;
        }

        const orderAttributes =
          OrderCalculator.createOrderAttributesForMarketType({
            exchangeConnector,
            exchangeName,
            symbol: resolvedSymbol,
            isLong,
            stopBuyAfterPercent,
            orderVolumeUsdt,
            uniqueSymbolCount,
            leverage,
            marketType: MarketType.Futures,
          });

        orderAttributesList.push(orderAttributes);
      },
    });

    return orderAttributesList;
  }

  public static enrichWithSpotFallback(
    args: EnrichWithSpotFallbackArgs
  ): OrderAttributes[] {
    const {
      orderAttributesList,
      exchangeConnectorByName,
      stopBuyAfterPercent,
      orderVolumeUsdt,
      leverage,
      uniqueSymbolCount,
    } = args;

    return orderAttributesList.map(orderAttributes => {
      const isNoPriceError = orderAttributes.errorText?.includes(
        NO_PRICE_DATA_AVAILABLE
      );

      if (!isNoPriceError) {
        return orderAttributes;
      }

      const { exchangeName, orderParams } = orderAttributes;
      const exchangeConnector = exchangeConnectorByName.get(exchangeName);

      if (!exchangeConnector) {
        return orderAttributes;
      }

      return OrderCalculator.createOrderAttributesForMarketType({
        exchangeConnector,
        exchangeName,
        symbol: orderParams.symbol,
        isLong: orderParams.side === OrderSideEnum.Buy,
        stopBuyAfterPercent,
        orderVolumeUsdt,
        uniqueSymbolCount,
        leverage,
        marketType: MarketType.Spot,
      });
    });
  }

  public static calculateLimitOrderWithPriceAdjustment(
    orderParams: OrderParams,
    priceAdjustmentPercent: number,
    orderVolumeUsdt: number,
    leverage: number = 1
  ): OrderParams {
    const adjustedPrice = OrderCalculator.addPercent(
      orderParams.price,
      priceAdjustmentPercent
    );
    const rawAmount = OrderCalculator.calculateOrderAmount(
      adjustedPrice,
      1,
      orderParams.marketType === MarketType.Spot
        ? orderVolumeUsdt / leverage
        : orderVolumeUsdt
    );

    return {
      ...orderParams,
      type: OrderTypeEnum.Limit,
      amount: rawAmount,
      price: adjustedPrice,
    };
  }

  public static calculateCloseOrder(
    orderParams: OrderParams,
    priceShiftPercent: number,
    isTakeProfit: boolean
  ): OrderParams {
    const isIncrease = priceShiftPercent > 0;
    const shiftedPrice = OrderCalculator.addPercent(
      orderParams.price,
      Math.abs(priceShiftPercent),
      isIncrease
    );
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
}
