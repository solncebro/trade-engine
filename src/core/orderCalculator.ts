import { logger } from './logger';

import { ExchangeConnector } from '../services/exchangeConnector';
import {
  CalculateAmountForMarketTypeArgs,
  ExchangeConnectorByName,
  ExchangeNameEnum,
  MarginModeEnum,
  MarketTypeEnum,
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
  allowedVolumeByExchange: Map<ExchangeNameEnum, number>;
  leverage: number;
}

interface CreateOrderAttributesForSymbolArgs extends BaseOrderCalculationArgs {
  isLong: boolean;
  exchangeConnectorByName: ExchangeConnectorByName;
  symbolMappingByExchange: SymbolMappingByExchange;
}

interface CreateOrderAttributesForMarketTypeArgs {
  exchangeConnector: ExchangeConnector;
  exchangeName: ExchangeNameEnum;
  symbol: string;
  isLong: boolean;
  stopBuyAfterPercent: number;
  allowedVolumeUsdt: number;
  uniqueSymbolCount: number;
  leverage: number;
  marketType: MarketTypeEnum;
}

interface EnrichWithSpotFallbackArgs extends BaseOrderCalculationArgs {
  orderAttributesList: OrderAttributes[];
  exchangeConnectorByName: ExchangeConnectorByName;
}

interface CalculateLimitOrderWithPriceAdjustmentArgs {
  orderParams: OrderParams;
  priceAdjustmentPercent: number;
  orderVolumeUsdt: number;
  leverage?: number;
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
    allowedVolumeUsdt: number
  ): number {
    const volumeUsdtPerSymbol = allowedVolumeUsdt / symbolCount;

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

  private static calculateAmountForMarketType(
    args: CalculateAmountForMarketTypeArgs
  ): number {
    const { price, allowedVolumeUsdt, uniqueSymbolCount, leverage, marketType } =
      args;

    const amount = OrderCalculator.calculateOrderAmount(
      price,
      uniqueSymbolCount,
      marketType === MarketTypeEnum.Spot
        ? allowedVolumeUsdt / leverage
        : allowedVolumeUsdt
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
      allowedVolumeUsdt,
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

    const orderVolumeUsdt = allowedVolumeUsdt / uniqueSymbolCount;

    const baseOrderParamsWithExchange: OrderAttributes = {
      orderParams: baseOrderParams,
      exchangeName,
      orderVolumeUsdt,
    };

    const marketLabel =
      marketType === MarketTypeEnum.Spot ? 'on spot ' : 'on futures ';

    if (!price) {
      const errorText = `🏷️ ${NO_PRICE_DATA_AVAILABLE} for ${symbol} ${marketLabel}on ${exchangeName}`;

      logger.warn({ symbol, exchange: exchangeName, marketType }, errorText);

      return {
        ...baseOrderParamsWithExchange,
        errorText,
      };
    }

    if (
      marketType !== MarketTypeEnum.Spot &&
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
      allowedVolumeUsdt,
      uniqueSymbolCount,
      leverage,
      marketType,
    });

    const amount = exchangeConnector.getClient(marketType).amountToPrecision(symbol, rawAmount);

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
          exchangeConnector.resolveSymbolWithPrefix(symbol, MarketTypeEnum.Futures);

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
              exchangeConnector.futures.setLeverage(leverage, resolvedSymbol),
              exchangeConnector.futures.setMarginMode(
                MarginModeEnum.Isolated,
                resolvedSymbol
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
      allowedVolumeByExchange,
      symbolMappingByExchange,
      leverage,
    } = args;

    const orderAttributesList: OrderAttributes[] = [];

    for (const [exchangeName, symbolMapping] of symbolMappingByExchange) {
      const exchangeConnector = exchangeConnectorByName.get(exchangeName);

      if (!exchangeConnector) {
        continue;
      }

      const allowedVolumeUsdt = allowedVolumeByExchange.get(exchangeName) ?? 0;
      const uniqueSymbolCount = symbolMapping.size;

      for (const [, resolvedSymbol] of symbolMapping) {
        orderAttributesList.push(
          OrderCalculator.createOrderAttributesForMarketType({
            exchangeConnector,
            exchangeName,
            symbol: resolvedSymbol,
            isLong,
            stopBuyAfterPercent,
            allowedVolumeUsdt,
            uniqueSymbolCount,
            leverage,
            marketType: MarketTypeEnum.Futures,
          })
        );
      }
    }

    return orderAttributesList;
  }

  public static enrichWithSpotFallback(
    args: EnrichWithSpotFallbackArgs
  ): OrderAttributes[] {
    const {
      orderAttributesList,
      exchangeConnectorByName,
      stopBuyAfterPercent,
      allowedVolumeByExchange,
      leverage,
    } = args;

    const symbolSetByExchange = new Map<ExchangeNameEnum, Set<string>>();

    for (const attr of orderAttributesList) {
      if (!symbolSetByExchange.has(attr.exchangeName)) {
        symbolSetByExchange.set(attr.exchangeName, new Set());
      }

      symbolSetByExchange.get(attr.exchangeName)!.add(attr.orderParams.symbol);
    }

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

      const allowedVolumeUsdt = allowedVolumeByExchange.get(exchangeName) ?? 0;
      const uniqueSymbolCount =
        symbolSetByExchange.get(exchangeName)?.size ?? 1;

      return OrderCalculator.createOrderAttributesForMarketType({
        exchangeConnector,
        exchangeName,
        symbol: orderParams.symbol,
        isLong: orderParams.side === OrderSideEnum.Buy,
        stopBuyAfterPercent,
        allowedVolumeUsdt,
        uniqueSymbolCount,
        leverage,
        marketType: MarketTypeEnum.Spot,
      });
    });
  }

  public static calculateLimitOrderWithPriceAdjustment(
    args: CalculateLimitOrderWithPriceAdjustmentArgs
  ): OrderParams {
    const {
      orderParams,
      priceAdjustmentPercent,
      orderVolumeUsdt,
      leverage = 1,
    } = args;

    const adjustedPrice = OrderCalculator.addPercent(
      orderParams.price,
      priceAdjustmentPercent
    );
    const rawAmount = OrderCalculator.calculateOrderAmount(
      adjustedPrice,
      1,
      orderParams.marketType === MarketTypeEnum.Spot
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
