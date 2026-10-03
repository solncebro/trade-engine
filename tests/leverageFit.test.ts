import type { LeverageTier } from '@solncebro/exchange-engine';

import { fitLeverage } from '../src/utils/leverageFit';
import type { FitLeverageArgs } from '../src/utils/leverageFit.types';

/** Bybit AVAUSDT risk-limit table as the exchange answered on 17.09.2026 (first eleven tiers). */
const BYBIT_AVAUSDT_TIER_LIST: LeverageTier[] = [
  { maxLeverage: 5, maxNotional: 5000, maxBaseAmount: null, initialMarginRate: 0.2, maintenanceMarginRate: 0.1 },
  { maxLeverage: 4.9, maxNotional: 6000, maxBaseAmount: null, initialMarginRate: 0.2041, maintenanceMarginRate: 0.102 },
  { maxLeverage: 4.8, maxNotional: 7000, maxBaseAmount: null, initialMarginRate: 0.2083, maintenanceMarginRate: 0.1042 },
  { maxLeverage: 4.7, maxNotional: 8000, maxBaseAmount: null, initialMarginRate: 0.2128, maintenanceMarginRate: 0.1064 },
  { maxLeverage: 4.6, maxNotional: 9000, maxBaseAmount: null, initialMarginRate: 0.2174, maintenanceMarginRate: 0.1087 },
  { maxLeverage: 4.5, maxNotional: 10000, maxBaseAmount: null, initialMarginRate: 0.2222, maintenanceMarginRate: 0.1111 },
  { maxLeverage: 4.4, maxNotional: 11000, maxBaseAmount: null, initialMarginRate: 0.2273, maintenanceMarginRate: 0.1136 },
  { maxLeverage: 4.3, maxNotional: 12000, maxBaseAmount: null, initialMarginRate: 0.2326, maintenanceMarginRate: 0.1163 },
  { maxLeverage: 4.2, maxNotional: 13000, maxBaseAmount: null, initialMarginRate: 0.2381, maintenanceMarginRate: 0.119 },
  { maxLeverage: 4.1, maxNotional: 14000, maxBaseAmount: null, initialMarginRate: 0.2439, maintenanceMarginRate: 0.122 },
  { maxLeverage: 4, maxNotional: 15000, maxBaseAmount: null, initialMarginRate: 0.25, maintenanceMarginRate: 0.125 },
];

/** Binance AVAUSDT leverage brackets, read from the owner's production server on 17.09.2026. */
const BINANCE_AVAUSDT_TIER_LIST: LeverageTier[] = [
  { maxLeverage: 25, maxNotional: 5000, maxBaseAmount: null, initialMarginRate: 0.04, maintenanceMarginRate: 0.02 },
  { maxLeverage: 20, maxNotional: 10000, maxBaseAmount: null, initialMarginRate: 0.05, maintenanceMarginRate: 0.025 },
  { maxLeverage: 10, maxNotional: 20000, maxBaseAmount: null, initialMarginRate: 0.1, maintenanceMarginRate: 0.05 },
  { maxLeverage: 5, maxNotional: 50000, maxBaseAmount: null, initialMarginRate: 0.2, maintenanceMarginRate: 0.1 },
  { maxLeverage: 4, maxNotional: 100000, maxBaseAmount: null, initialMarginRate: 0.25, maintenanceMarginRate: 0.125 },
  { maxLeverage: 3, maxNotional: 250000, maxBaseAmount: null, initialMarginRate: 0.3333, maintenanceMarginRate: 0.1667 },
];

function args(overrides: Partial<FitLeverageArgs>): FitLeverageArgs {
  return {
    tierList: BYBIT_AVAUSDT_TIER_LIST,
    desiredLeverage: 5,
    currentLeverage: null,
    isSymbolBusy: false,
    planUsd: 10000,
    committedUsd: 0,
    freeMarginUsd: 3281,
    price: 0.1904,
    ...overrides,
  };
}

describe('fitLeverage', () => {
  it('AVAUSDT on Bybit: a $10000 plan at ×5 (cap $5000) goes to ×4.4 — the exchange itself named ×4.5, but a plan sitting exactly on its $10000 cap has no room for the mark drift', () => {
    const fit = fitLeverage(args({}));

    expect(fit.verdict).toBe('lowered');
    expect(fit.leverage).toBe(4.4);
    expect(fit.allowedUsd).toBe(10000);
    expect(fit.capAtDesiredUsd).toBe(5000);
    expect(fit.extraMarginUsd).toBeCloseTo(2273, 0);
  });

  it('AVAUSDT on Binance: the same plan fits at ×5 as is (cap $50000)', () => {
    const fit = fitLeverage(args({ tierList: BINANCE_AVAUSDT_TIER_LIST }));

    expect(fit.verdict).toBe('fits');
    expect(fit.leverage).toBe(5);
    expect(fit.allowedUsd).toBe(10000);
  });

  it('keeps a 3 % headroom under the cap: a plan of exactly the cap does not fit at that tier', () => {
    const fit = fitLeverage(args({ planUsd: 5000 }));

    expect(fit.verdict).toBe('lowered');
    expect(fit.leverage).toBe(4.9);
  });

  it('the incident itself: $5000 already filled at ×5, the next orders would breach the cap — lowers to ×4.5 counting only the EXTRA margin', () => {
    const fit = fitLeverage(args({ currentLeverage: 5, isSymbolBusy: true, committedUsd: 5000, freeMarginUsd: 3281 }));

    expect(fit.verdict).toBe('lowered');
    expect(fit.leverage).toBe(4.4);
    expect(fit.extraMarginUsd).toBeCloseTo(10000 * 0.2273 - 5000 * 0.2, 0);
  });

  it("lowers only as far as the free margin allows and places what fits at that tier (owner's rule)", () => {
    const fit = fitLeverage(args({ freeMarginUsd: 1750 }));

    expect(fit.verdict).toBe('lowered_partially');
    expect(fit.leverage).toBe(4.7);
    expect(fit.allowedUsd).toBeCloseTo(8000 / 1.03, 6);
  });

  it("does not touch the leverage when even the current tier's margin is out of reach — places up to the cap", () => {
    const fit = fitLeverage(args({ freeMarginUsd: 300 }));

    expect(fit.verdict).toBe('capped');
    expect(fit.leverage).toBe(5);
    expect(fit.allowedUsd).toBeCloseTo(5000 / 1.03, 6);
    expect(fit.explanation).toContain('free');
  });

  it('an unreadable balance is not a zero balance: nothing is lowered, the cap at the desired leverage rules', () => {
    const fit = fitLeverage(args({ freeMarginUsd: null }));

    expect(fit.verdict).toBe('capped');
    expect(fit.leverage).toBe(5);
    expect(fit.explanation).toContain('could not be read');
  });

  it('never raises the leverage on a busy symbol: current ×4 with a setting of ×5 stays ×4', () => {
    const fit = fitLeverage(args({ currentLeverage: 4, isSymbolBusy: true, committedUsd: 5000, planUsd: 10000 }));

    expect(fit.verdict).toBe('fits');
    expect(fit.leverage).toBe(4);
  });

  it('a busy symbol with an UNKNOWN current leverage is never re-set: only the cap at the setting is applied', () => {
    const fit = fitLeverage(args({ currentLeverage: null, isSymbolBusy: true, committedUsd: 5000 }));

    expect(fit.verdict).toBe('capped');
    expect(fit.leverage).toBe(5);
    expect(fit.allowedUsd).toBe(5000);
    expect(fit.explanation).toContain('unknown');
  });

  it("a setting above the symbol's maximum is clamped to that maximum and reported", () => {
    const fit = fitLeverage(args({ desiredLeverage: 10, tierList: BINANCE_AVAUSDT_TIER_LIST.slice(3), planUsd: 1000 }));

    expect(fit.verdict).toBe('fits');
    expect(fit.leverage).toBe(5);
    expect(fit.isClampedToSymbolMax).toBe(true);
  });

  it('allows never less than what is already committed on the exchange', () => {
    const fit = fitLeverage(args({ currentLeverage: 5, isSymbolBusy: true, committedUsd: 5200, planUsd: 10000, freeMarginUsd: 0 }));

    expect(fit.verdict).toBe('capped');
    expect(fit.allowedUsd).toBe(5200);
  });

  it('without a tier table nothing is judged: the setting stands and the whole plan is allowed', () => {
    const fit = fitLeverage(args({ tierList: [] }));

    expect(fit.verdict).toBe('no_tiers');
    expect(fit.leverage).toBe(5);
    expect(fit.allowedUsd).toBe(10000);
  });

  it('converts a base-amount cap (OKX) into money by the price', () => {
    const okxTierList: LeverageTier[] = [
      { maxLeverage: 20, maxNotional: null, maxBaseAmount: 10, initialMarginRate: 0.05, maintenanceMarginRate: 0.02 },
      { maxLeverage: 10, maxNotional: null, maxBaseAmount: 100, initialMarginRate: 0.1, maintenanceMarginRate: 0.05 },
    ];
    const fit = fitLeverage(args({ tierList: okxTierList, desiredLeverage: 20, planUsd: 5000, price: 100, freeMarginUsd: 10000 }));

    expect(fit.capAtDesiredUsd).toBe(1000);
    expect(fit.verdict).toBe('lowered');
    expect(fit.leverage).toBe(10);
  });
});
