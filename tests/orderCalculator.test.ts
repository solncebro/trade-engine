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
      // price=1000, +10% → 1000 * 1.1 = 1100
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.price).toBe(1100);
    });

    test('calculates futures amount as volume / adjustedPrice', () => {
      // adjustedPrice = 1000 * 1.1 = 1100, amount = 100 / 1100
      const result = OrderCalculator.calculateLimitOrderWithPriceAdjustment({
        orderParams: BASE_ORDER_PARAMS,
        priceAdjustmentPercent: 10,
        orderVolumeUsdt: 100,
      });

      expect(result.amount).toBe(100 / 1100);
    });

    test('reduces spot amount by leverage', () => {
      // adjustedPrice = 1000, spotVolume = 100 / 5 = 20, amount = 20 / 1000 = 0.02
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
      // rawAmount = 100 / 1100, mock rounds to 4 decimal places
      const adjustedPrice = 1000 * 1.1; // 1100
      const rawAmount = 100 / adjustedPrice;
      const roundedAmount = Math.floor(rawAmount * 10000) / 10000; // 0.0909

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
      const adjustedPrice = 1000 * 1.1; // 1100
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
      // rawAmount uses adjustedPrice in denominator, not original price
      const priceAdjustmentPercent = 20;
      const adjustedPrice = 1000 * (1 + priceAdjustmentPercent / 100); // 1200
      const orderVolumeUsdt = 240;
      const expectedRawAmount = orderVolumeUsdt / adjustedPrice; // 0.2

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
      // 100 / 1100 is a repeating decimal — should remain unrounded
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
