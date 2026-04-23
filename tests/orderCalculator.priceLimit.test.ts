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
});
