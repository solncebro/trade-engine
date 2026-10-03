import type { LeverageTier } from '@solncebro/exchange-engine';

import { computeMaxLeverageBeforeStop, estimateIsolatedLiquidationPrice, resolveEntryLeverage } from '../src/utils/liquidationLeverage';

/** Binance AVAUSDT leverage brackets as rubber recorded them from production on 17.09.2026 (rubber leverageFit.test.ts). */
const BINANCE_AVAUSDT_TIER_LIST: LeverageTier[] = [
  { maxLeverage: 25, maxNotional: 5000, maxBaseAmount: null, initialMarginRate: 0.04, maintenanceMarginRate: 0.02 },
  { maxLeverage: 20, maxNotional: 10000, maxBaseAmount: null, initialMarginRate: 0.05, maintenanceMarginRate: 0.025 },
  { maxLeverage: 10, maxNotional: 20000, maxBaseAmount: null, initialMarginRate: 0.1, maintenanceMarginRate: 0.05 },
  { maxLeverage: 5, maxNotional: 50000, maxBaseAmount: null, initialMarginRate: 0.2, maintenanceMarginRate: 0.1 },
];

/** Bybit AVAUSDT risk limits as rubber recorded them on 17.09.2026 (first six tiers). */
const BYBIT_AVAUSDT_TIER_LIST: LeverageTier[] = [
  { maxLeverage: 5, maxNotional: 5000, maxBaseAmount: null, initialMarginRate: 0.2, maintenanceMarginRate: 0.1 },
  { maxLeverage: 4.9, maxNotional: 6000, maxBaseAmount: null, initialMarginRate: 0.2041, maintenanceMarginRate: 0.102 },
  { maxLeverage: 4.8, maxNotional: 7000, maxBaseAmount: null, initialMarginRate: 0.2083, maintenanceMarginRate: 0.1042 },
  { maxLeverage: 4.7, maxNotional: 8000, maxBaseAmount: null, initialMarginRate: 0.2128, maintenanceMarginRate: 0.1064 },
  { maxLeverage: 4.6, maxNotional: 9000, maxBaseAmount: null, initialMarginRate: 0.2174, maintenanceMarginRate: 0.1087 },
  { maxLeverage: 4.5, maxNotional: 10000, maxBaseAmount: null, initialMarginRate: 0.2222, maintenanceMarginRate: 0.1111 },
  { maxLeverage: 4.4, maxNotional: 11000, maxBaseAmount: null, initialMarginRate: 0.2273, maintenanceMarginRate: 0.1136 },
];

describe('estimateIsolatedLiquidationPrice', () => {
  it('long: EP × (1 − 1/L) / (1 − MMR)', () => {
    expect(estimateIsolatedLiquidationPrice({ entryPrice: 100, leverage: 10, direction: 'long', maintenanceMarginPercent: 0.5 })).toBeCloseTo(90 / 0.995, 9);
  });

  it('short: EP × (1 + 1/L) / (1 + MMR)', () => {
    expect(estimateIsolatedLiquidationPrice({ entryPrice: 100, leverage: 10, direction: 'short', maintenanceMarginPercent: 0.5 })).toBeCloseTo(110 / 1.005, 9);
  });

  it('long at ×1 never liquidates above zero', () => {
    expect(estimateIsolatedLiquidationPrice({ entryPrice: 100, leverage: 1, direction: 'long', maintenanceMarginPercent: 1 })).toBe(0);
  });
});

describe('computeMaxLeverageBeforeStop', () => {
  const base = { entryPrice: 100, liquidationBufferPercent: 1, maintenanceMarginPercent: 0.5, maxLeverage: 20 };

  it('long: the largest whole leverage whose liquidation lies below the stop by the buffer', () => {
    const result = computeMaxLeverageBeforeStop({ ...base, stopPrice: 90, direction: 'long' });

    expect(result).toMatchObject({ isFound: true, leverage: 8, limitedBy: 'stop' });
    expect(result.isFound && result.liquidationPrice).toBeCloseTo(87.5 / 0.995, 9);
    // One step higher already breaks the rule.
    expect(estimateIsolatedLiquidationPrice({ entryPrice: 100, leverage: 9, direction: 'long', maintenanceMarginPercent: 0.5 })).toBeGreaterThan(90 * 0.99);
  });

  it('short: mirror image above the stop', () => {
    const result = computeMaxLeverageBeforeStop({ ...base, stopPrice: 110, direction: 'short' });

    expect(result).toMatchObject({ isFound: true, leverage: 8, limitedBy: 'stop' });
    expect(result.isFound && result.liquidationPrice).toBeGreaterThanOrEqual(110 * 1.01);
  });

  it('keeps the requested leverage when the stop is far enough', () => {
    expect(computeMaxLeverageBeforeStop({ ...base, stopPrice: 90, direction: 'long', maxLeverage: 5 })).toMatchObject({ isFound: true, leverage: 5, limitedBy: 'max_leverage' });
  });

  it('only whole leverages: a fractional ceiling is floored', () => {
    expect(computeMaxLeverageBeforeStop({ ...base, stopPrice: 90, direction: 'long', maxLeverage: 5.7 })).toMatchObject({ isFound: true, leverage: 5 });
  });

  it('refuses a stop on the profit side of the entry', () => {
    expect(computeMaxLeverageBeforeStop({ ...base, stopPrice: 105, direction: 'long' })).toEqual({ isFound: false, reason: 'stop_on_wrong_side' });
    expect(computeMaxLeverageBeforeStop({ ...base, stopPrice: 95, direction: 'short' })).toEqual({ isFound: false, reason: 'stop_on_wrong_side' });
  });

  it('reports a short whose stop is beyond even the ×1 liquidation', () => {
    expect(computeMaxLeverageBeforeStop({ ...base, stopPrice: 199.9, direction: 'short' })).toEqual({ isFound: false, reason: 'stop_too_close' });
  });

  it('refuses invalid input and a missing maintenance rate', () => {
    expect(computeMaxLeverageBeforeStop({ ...base, entryPrice: 0, stopPrice: 90, direction: 'long' })).toEqual({ isFound: false, reason: 'invalid_input' });
    expect(computeMaxLeverageBeforeStop({ ...base, maxLeverage: 0.5, stopPrice: 90, direction: 'long' })).toEqual({ isFound: false, reason: 'invalid_input' });
    expect(computeMaxLeverageBeforeStop({ entryPrice: 100, stopPrice: 90, direction: 'long', liquidationBufferPercent: 1, maxLeverage: 5 })).toEqual({ isFound: false, reason: 'no_maintenance_margin' });
  });

  it('tier table by position size: margin × L picks the tier, its maintenance rate and its leverage cap', () => {
    const result = computeMaxLeverageBeforeStop({
      entryPrice: 100,
      stopPrice: 97,
      direction: 'long',
      liquidationBufferPercent: 0.5,
      leverageTierList: BINANCE_AVAUSDT_TIER_LIST,
      marginUsd: 400,
      maxLeverage: 25,
    });

    // ×25 → $10000 → tier 2 (max ×20) refuses; ×17 → LP 96.53 above 96.515; ×16 → $6400, 2.5 % → LP 96.15.
    expect(result).toMatchObject({ isFound: true, leverage: 16, maintenanceMarginPercent: 2.5, limitedBy: 'stop' });
  });

  it('a leverage above the symbol maximum is cut by the tier, and reported so', () => {
    const result = computeMaxLeverageBeforeStop({
      entryPrice: 100,
      stopPrice: 99,
      direction: 'long',
      liquidationBufferPercent: 0.1,
      leverageTierList: BINANCE_AVAUSDT_TIER_LIST,
      maxLeverage: 30,
    });

    expect(result).toMatchObject({ isFound: true, leverage: 25, maintenanceMarginPercent: 2, limitedBy: 'tier' });
  });

  it('with an explicit rate AND tiers, the larger maintenance rate rules (safe side)', () => {
    const result = computeMaxLeverageBeforeStop({
      entryPrice: 100,
      stopPrice: 99,
      direction: 'long',
      liquidationBufferPercent: 0.1,
      maintenanceMarginPercent: 3,
      leverageTierList: BINANCE_AVAUSDT_TIER_LIST,
      maxLeverage: 25,
    });

    // Tier 1 says 2 %, the caller says 3 %: at 3 % ×25 liquidates at 98.97, above 98.901 — ×24 is the answer.
    expect(result).toMatchObject({ isFound: true, leverage: 24, maintenanceMarginPercent: 3 });
  });

  it('a position too large for every tier is reported as such', () => {
    const result = computeMaxLeverageBeforeStop({
      entryPrice: 100,
      stopPrice: 90,
      direction: 'long',
      liquidationBufferPercent: 1,
      leverageTierList: BINANCE_AVAUSDT_TIER_LIST,
      marginUsd: 100000,
      maxLeverage: 5,
    });

    expect(result).toEqual({ isFound: false, reason: 'no_tier_for_size' });
  });
});

describe('resolveEntryLeverage', () => {
  const stopGuard = { entryPrice: 100, direction: 'long' as const, liquidationBufferPercent: 1, maintenanceMarginPercent: 0.5 };

  it('keeps the signal leverage when the stop is far from the liquidation', () => {
    const result = resolveEntryLeverage({ desiredLeverage: 5, stopGuard: { ...stopGuard, stopPrice: 90 }, tierFit: null });

    expect(result).toMatchObject({ isResolved: true, leverage: 5, limitedBy: 'desired' });
  });

  it('lowers the leverage so the liquidation stays beyond a wide stop', () => {
    const result = resolveEntryLeverage({ desiredLeverage: 5, stopGuard: { ...stopGuard, stopPrice: 75 }, tierFit: null });

    expect(result).toMatchObject({ isResolved: true, leverage: 3, limitedBy: 'stop' });
    expect(result.explanation).toContain('×5 → ×3');
  });

  it('then fits the tier caps: Bybit AVAUSDT $10000 at ×5 goes to ×4.4 (rubber incident 17.09.2026)', () => {
    const result = resolveEntryLeverage({
      desiredLeverage: 5,
      stopGuard: null,
      tierFit: { tierList: BYBIT_AVAUSDT_TIER_LIST, currentLeverage: null, isSymbolBusy: false, planUsd: 10000, committedUsd: 0, freeMarginUsd: 3281, price: 0.1904 },
    });

    expect(result).toMatchObject({ isResolved: true, leverage: 4.4, limitedBy: 'tier_cap' });
  });

  it('the tier step never raises what the stop guard lowered', () => {
    const result = resolveEntryLeverage({
      desiredLeverage: 5,
      stopGuard: { ...stopGuard, stopPrice: 75 },
      tierFit: { tierList: BYBIT_AVAUSDT_TIER_LIST, currentLeverage: null, isSymbolBusy: false, planUsd: 1000, committedUsd: 0, freeMarginUsd: 3281, price: 0.1904 },
    });

    expect(result).toMatchObject({ isResolved: true, leverage: 3, limitedBy: 'stop' });
  });

  it('a stop on the wrong side leaves the leverage unresolved with the reason', () => {
    const result = resolveEntryLeverage({ desiredLeverage: 5, stopGuard: { ...stopGuard, stopPrice: 110 }, tierFit: null });

    expect(result).toMatchObject({ isResolved: false, reason: 'stop_on_wrong_side' });
  });
});
