import type { PriceLimitRisk, TradeSymbol } from '@solncebro/exchange-engine';

export interface PriceLimitBoundsArgs {
  tradeSymbol: TradeSymbol;
  markPrice: number;
  indexPrice?: number;
}

export interface PriceLimitBounds {
  minPrice: number;
  maxPrice: number;
  minDeviationPercent: number;
  maxDeviationPercent: number;
  source: PriceLimitRisk['source'];
}
