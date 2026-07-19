import { OrderCalculator } from '../src/core/orderCalculator';
import { TradeSymbol, TradeSymbolTypeEnum } from '../src/types';

const BASE_TRADE_SYMBOL: TradeSymbol = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  settle: 'USDT',
  isActive: true,
  type: TradeSymbolTypeEnum.Swap,
  isLinear: true,
  contractSize: 1,
  contractType: 'LinearPerpetual',
  filter: {
    tickSize: '0.1',
    stepSize: '0.001',
    minQty: '0.001',
    maxQty: '100',
    minNotional: '5',
  },
};

describe('OrderCalculator.calculatePriceLimitBounds', () => {
  describe('bybitRiskParameters', () => {
    const bybitTradeSymbol: TradeSymbol = {
      ...BASE_TRADE_SYMBOL,
      priceLimitRisk: {
        source: 'bybitRiskParameters',
        priceLimitRatioX: '0.01',
        priceLimitRatioY: '0.02',
      },
    };

    test('indexPrice equals markPrice — inner limit applied', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
      });

      expect(result).not.toBeNull();
      expect(result!.maxPrice).toBeCloseTo(101, 6);
      expect(result!.minPrice).toBeCloseTo(99, 6);
      expect(result!.maxDeviationPercent).toBeCloseTo(1, 6);
      expect(result!.minDeviationPercent).toBeCloseTo(-1, 6);
      expect(result!.source).toBe('bybitRiskParameters');
    });

    test('indexPrice above outer bound — clamped to MarkPrice * (1 + Y)', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 150,
      });

      expect(result!.maxPrice).toBeCloseTo(102, 6);
    });

    test('indexPrice below outer bound — clamped to MarkPrice * (1 - Y)', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 50,
      });

      expect(result!.minPrice).toBeCloseTo(98, 6);
    });

    test('indexPrice undefined — falls back to markPrice (inner limit)', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
      });

      expect(result!.maxPrice).toBeCloseTo(101, 6);
      expect(result!.minPrice).toBeCloseTo(99, 6);
    });

    test('indexPrice <= 0 — falls back to markPrice', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 0,
      });

      expect(result!.maxPrice).toBeCloseTo(101, 6);
      expect(result!.minPrice).toBeCloseTo(99, 6);
    });
  });

  describe('binancePercentPrice', () => {
    const binanceTradeSymbol: TradeSymbol = {
      ...BASE_TRADE_SYMBOL,
      priceLimitRisk: {
        source: 'binancePercentPrice',
        multiplierUp: '1.0500',
        multiplierDown: '0.9500',
        multiplierDecimal: '4',
      },
    };

    test('multiplierUp=1.05 — maxDeviationPercent = 5', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: binanceTradeSymbol,
        markPrice: 100,
      });

      expect(result).not.toBeNull();
      expect(result!.maxPrice).toBeCloseTo(105, 6);
      expect(result!.minPrice).toBeCloseTo(95, 6);
      expect(result!.maxDeviationPercent).toBeCloseTo(5, 6);
      expect(result!.minDeviationPercent).toBeCloseTo(-5, 6);
      expect(result!.source).toBe('binancePercentPrice');
    });
  });

  describe('binancePercentPriceBySide', () => {
    test('returns null (spot bid/ask not supported)', () => {
      const tradeSymbol: TradeSymbol = {
        ...BASE_TRADE_SYMBOL,
        priceLimitRisk: {
          source: 'binancePercentPriceBySide',
          bidMultiplierUp: '5',
          bidMultiplierDown: '0.2',
          askMultiplierUp: '5',
          askMultiplierDown: '0.2',
          avgPriceMins: 5,
        },
      };

      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol,
        markPrice: 100,
      });

      expect(result).toBeNull();
    });
  });

  describe('missing data', () => {
    test('priceLimitRisk undefined — returns null', () => {
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: BASE_TRADE_SYMBOL,
        markPrice: 100,
      });

      expect(result).toBeNull();
    });

    test('markPrice = 0 — returns null', () => {
      const tradeSymbol: TradeSymbol = {
        ...BASE_TRADE_SYMBOL,
        priceLimitRisk: {
          source: 'binancePercentPrice',
          multiplierUp: '1.05',
          multiplierDown: '0.95',
          multiplierDecimal: '4',
        },
      };

      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol,
        markPrice: 0,
      });

      expect(result).toBeNull();
    });
  });

  describe('bybitRiskParameters with premiumAvg', () => {
    const bybitTradeSymbol: TradeSymbol = {
      ...BASE_TRADE_SYMBOL,
      priceLimitRisk: {
        source: 'bybitRiskParameters',
        priceLimitRatioX: '0.01',
        priceLimitRatioY: '0.02',
      },
    };

    test('matches the BTCUSDT example from Bybit Derivatives-Trading-Rules', () => {
      // Mark = 59500, Index = 60000, MidPrice = 60000, PremiumAvg = 500, X = 1%, Y = 2%
      // Expected highest_bid = 60595 (from official documentation example)
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 59500,
        indexPrice: 60000,
        premiumAvg: 500,
      });

      expect(result).not.toBeNull();
      expect(result!.maxPrice).toBeCloseTo(60595, 4);
    });

    test('premiumAvg = 0 collapses to the simplified formula (cold start)', () => {
      const withZeroPremium = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: 0,
      });
      const withoutPremium = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
      });

      expect(withZeroPremium!.maxPrice).toBeCloseTo(withoutPremium!.maxPrice, 10);
      expect(withZeroPremium!.minPrice).toBeCloseTo(withoutPremium!.minPrice, 10);
    });

    test('large positive premium is clipped by Mark × (1 + Y)', () => {
      // X = 1%, Y = 2%, premium = 100 (huge) -> mark*(1+X)+premium = 201 >> mark*(1+Y) = 102
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: 100,
      });

      expect(result!.maxPrice).toBeCloseTo(102, 6);
    });

    test('negative premium leaves maxPrice unchanged (Max(0, premium) = 0)', () => {
      const withZero = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: 0,
      });
      const withNegative = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: -5,
      });

      expect(withNegative!.maxPrice).toBeCloseTo(withZero!.maxPrice, 10);
    });

    test('negative premium pushes minPrice down (Min(0, premium) = premium)', () => {
      // X = 1%, Y = 2%, premium = -1 -> mark*(1-X)+premium = 98 -> Min(index=100, 98) = 98
      // -> Max(mark*(1-Y) = 98, 98) = 98
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: -1,
      });

      expect(result!.minPrice).toBeCloseTo(98, 6);
    });

    test('index above mark*(1+X)+premium pins maxPrice to index (still clipped by outer Y)', () => {
      // Mark = 100, X = 1%, Y = 2%, premium = 0, index = 101.5
      // mark*(1+X)+0 = 101 -> Max(index=101.5, 101) = 101.5
      // Min(mark*(1+Y) = 102, 101.5) = 101.5
      const result = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 101.5,
        premiumAvg: 0,
      });

      expect(result!.maxPrice).toBeCloseTo(101.5, 6);
    });

    test('non-finite premiumAvg is treated as 0', () => {
      const withNaN = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: Number.NaN,
      });
      const withZero = OrderCalculator.calculatePriceLimitBounds({
        tradeSymbol: bybitTradeSymbol,
        markPrice: 100,
        indexPrice: 100,
        premiumAvg: 0,
      });

      expect(withNaN!.maxPrice).toBeCloseTo(withZero!.maxPrice, 10);
      expect(withNaN!.minPrice).toBeCloseTo(withZero!.minPrice, 10);
    });
  });
});
