import type { PriceLimitRisk, TradeSymbol } from '@solncebro/exchange-engine';

export interface PriceLimitBoundsArgs {
  tradeSymbol: TradeSymbol;
  markPrice: number;
  indexPrice?: number;
  // NOTE: no premium term here. The official Bybit price-limit formula
  // (help-center "Derivatives Trading Rules") is
  //   highest_bid = Min( Mark × (1+Y), Max( Index, Mark × (1+X) ) )
  // A previous version carried a self-invented `premiumAvg` addend (EMA of
  // mid − mark) that inflated the computed band exactly on pinned pumps and
  // burned the OPGUSDT 2026-07-07 entry — removed deliberately.
}

export interface PriceLimitBounds {
  minPrice: number;
  maxPrice: number;
  minDeviationPercent: number;
  maxDeviationPercent: number;
  source: PriceLimitRisk['source'];
}
