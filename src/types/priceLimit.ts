import type { PriceLimitRisk, TradeSymbol } from '@solncebro/exchange-engine';

export interface PriceLimitBoundsArgs {
  tradeSymbol: TradeSymbol;
  markPrice: number;
  indexPrice?: number;
  /**
   * Premium term used by Bybit when evaluating the limit bands for USDT perp:
   * EMA( MidPrice − Mark, 30s ), MidPrice = (Ask1 + Bid1) / 2.
   * Bybit does not publish this on public streams, so the caller is responsible
   * for tracking it (see {@link PremiumIndexCalculator}). When omitted, premium
   * is treated as 0, which matches the cold-start state immediately after a
   * shock when the EMA has not yet accumulated.
   */
  premiumAvg?: number;
}

export interface PriceLimitBounds {
  minPrice: number;
  maxPrice: number;
  minDeviationPercent: number;
  maxDeviationPercent: number;
  source: PriceLimitRisk['source'];
}
