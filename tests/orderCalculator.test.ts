import { PositionSideEnum } from '@solncebro/exchange-engine';

import { OrderCalculator } from '../src/core/orderCalculator';
import { ExchangeClient, MarketTypeEnum, OrderSideEnum, OrderTypeEnum } from '../src/types';

const BASE_ORDER_PARAMS = {
  symbol: 'BTCUSDT',
  side: OrderSideEnum.Buy,
  amount: 0.01,
  price: 1000,
  type: OrderTypeEnum.Market,
  marketType: MarketTypeEnum.Futures,
};

describe('OrderCalculator.calculateLimitOrderWithPriceAdjustment', () => {
  describe('without exchangeClient', () => {
    test('returns Limit order type', () => {
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.type).toBe(OrderTypeEnum.Limit);
    });

    test('adjusts price by percent', () => {
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.price).toBe(1100);
    });

    test('calculates futures amount as volume / adjustedPrice', () => {
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.amount).toBe(100 / 1100);
    });

    test('reduces spot amount by leverage', () => {
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: { ...BASE_ORDER_PARAMS, marketType: MarketTypeEnum.Spot },
        priceAdjustmentPercent: 0,
        orderVolumeUsdt: 100,
        leverage: 5,
      });

      expect(result.amount).toBe(0.02);
    });

    test('preserves all other orderParams fields', () => {
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.symbol).toBe(BASE_ORDER_PARAMS.symbol);
      expect(result.side).toBe(BASE_ORDER_PARAMS.side);
      expect(result.marketType).toBe(BASE_ORDER_PARAMS.marketType);
    });
  });

  describe('with exchangeClient', () => {
    const makeExchangeClient = (
      amountFn: (symbol: string, amount: number) => number,
      priceFn: (symbol: string, price: number) => number
    ): ExchangeClient =>
      ({
        amountToPrecision: jest.fn(amountFn),
        priceToPrecision: jest.fn(priceFn),
      }) as unknown as ExchangeClient;

    test('applies amountToPrecision to the calculated amount', () => {
      const adjustedPrice = 1000 * 1.1;
      const rawAmount = 100 / adjustedPrice;
      const roundedAmount = Math.floor(rawAmount * 10000) / 10000;

      const exchangeClient = makeExchangeClient(
        () => roundedAmount,
        (_, p) => p
      );

      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
        exchangeClient,
      });

      expect(result.amount).toBe(roundedAmount);
      expect((exchangeClient.amountToPrecision as jest.Mock).mock.calls[0]).toEqual([
        'BTCUSDT',
        rawAmount,
      ]);
    });

    test('applies priceToPrecision to the adjusted price', () => {
      const adjustedPrice = 1000 * 1.1;
      const roundedPrice = 1100.5;

      const exchangeClient = makeExchangeClient(
        (_, a) => a,
        () => roundedPrice
      );

      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
        exchangeClient,
      });

      expect(result.price).toBe(roundedPrice);
      expect((exchangeClient.priceToPrecision as jest.Mock).mock.calls[0]).toEqual([
        'BTCUSDT',
        adjustedPrice,
      ]);
    });

    test('passes rawAmount (not adjusted) to amountToPrecision', () => {
      const priceAdjustmentPercent = 20;
      const adjustedPrice = 1000 * (1 + priceAdjustmentPercent / 100);
      const orderVolumeUsdt = 240;
      const expectedRawAmount = orderVolumeUsdt / adjustedPrice;

      const exchangeClient = makeExchangeClient(jest.fn((_, a) => a), jest.fn((_, p) => p));

      OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent,
        orderVolumeUsdt,
        exchangeClient,
      });

      expect((exchangeClient.amountToPrecision as jest.Mock).mock.calls[0][1]).toBe(
        expectedRawAmount
      );
    });

    test('without exchangeClient does not round values', () => {
      const withClient = makeExchangeClient(
        (_, a) => Math.floor(a * 1000) / 1000,
        (_, p) => p
      );

      const withoutClient = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      const withClientResult = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
        exchangeClient: withClient,
      });

      expect(withoutClient.amount).not.toBe(withClientResult.amount);
      expect(withoutClient.amount).toBeGreaterThan(withClientResult.amount as number);
    });
  });
});

describe('OrderCalculator.calculateCloseOrder', () => {
  test('inverts side from Buy to Sell', () => {
    const result = OrderCalculator.calculateCloseOrder(
      { ...BASE_ORDER_PARAMS, side: OrderSideEnum.Buy },
      10,
      true
    );

    expect(result.side).toBe(OrderSideEnum.Sell);
  });

  test('inverts side from Sell to Buy', () => {
    const result = OrderCalculator.calculateCloseOrder(
      { ...BASE_ORDER_PARAMS, side: OrderSideEnum.Sell },
      10,
      true
    );

    expect(result.side).toBe(OrderSideEnum.Buy);
  });

  test('preserves Long positionSide for closing the long side', () => {
    const result = OrderCalculator.calculateCloseOrder(
      {
        ...BASE_ORDER_PARAMS,
        side: OrderSideEnum.Buy,
        positionSide: PositionSideEnum.Long,
      },
      10,
      true
    );

    expect(result.positionSide).toBe(PositionSideEnum.Long);
    expect(result.side).toBe(OrderSideEnum.Sell);
  });

  test('preserves Short positionSide for closing the short side', () => {
    const result = OrderCalculator.calculateCloseOrder(
      {
        ...BASE_ORDER_PARAMS,
        side: OrderSideEnum.Sell,
        positionSide: PositionSideEnum.Short,
      },
      10,
      false
    );

    expect(result.positionSide).toBe(PositionSideEnum.Short);
    expect(result.side).toBe(OrderSideEnum.Buy);
  });

  test('leaves positionSide undefined when entry has no positionSide (one-way mode)', () => {
    const result = OrderCalculator.calculateCloseOrder(
      { ...BASE_ORDER_PARAMS, side: OrderSideEnum.Buy },
      10,
      true
    );

    expect(result.positionSide).toBeUndefined();
  });

  test('attaches reduceOnly param for futures close', () => {
    const result = OrderCalculator.calculateCloseOrder(
      {
        ...BASE_ORDER_PARAMS,
        marketType: MarketTypeEnum.Futures,
        positionSide: PositionSideEnum.Long,
      },
      10,
      true
    );

    expect(result.params).toEqual({ reduceOnly: true });
  });

  test('does not attach reduceOnly for spot close', () => {
    const result = OrderCalculator.calculateCloseOrder(
      { ...BASE_ORDER_PARAMS, marketType: MarketTypeEnum.Spot },
      10,
      true
    );

    expect(result.params).toBeUndefined();
  });
});
