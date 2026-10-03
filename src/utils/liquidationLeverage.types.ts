import type { LeverageTier } from '@solncebro/exchange-engine';

import type { FitLeverageArgs, LeverageFit } from './leverageFit.types';

interface EstimateIsolatedLiquidationPriceArgs {
  entryPrice: number;
  leverage: number;
  direction: 'long' | 'short';
  /** Maintenance margin in PERCENT of the position value (0.5 = 0.5 %). */
  maintenanceMarginPercent: number;
}

interface ComputeMaxLeverageBeforeStopArgs {
  entryPrice: number;
  stopPrice: number;
  direction: 'long' | 'short';
  /** Maintenance margin in PERCENT of the position value. With a tier list too, the larger of the two rules. */
  maintenanceMarginPercent?: number;
  /** Tier table of the symbol (ExchangeConnector.getFuturesLeverageTierList): supplies the maintenance rate
   *  of the tier the position lands in and the highest leverage that tier admits. */
  leverageTierList?: ReadonlyArray<LeverageTier>;
  /** Margin put into the position, USD: position value at leverage L = marginUsd × L picks the tier.
   *  Without it the widest tier still admitting L is assumed — the highest maintenance rate, the safe side. */
  marginUsd?: number;
  /** How far beyond the stop the liquidation must lie, in PERCENT of the stop price. */
  liquidationBufferPercent: number;
  /** Upper bound: the signal's (or default) leverage. Only whole leverages up to it are tried. */
  maxLeverage: number;
}

type MaxLeverageLimit = 'max_leverage' | 'stop' | 'tier';

type MaxLeverageRefusal =
  | 'invalid_input'
  | 'stop_on_wrong_side'
  | 'no_maintenance_margin'
  | 'stop_too_close'
  | 'no_tier_for_size';

type MaxLeverageBeforeStop =
  | {
      isFound: true;
      leverage: number;
      liquidationPrice: number;
      maintenanceMarginPercent: number;
      /** What kept the leverage from being one step higher. */
      limitedBy: MaxLeverageLimit;
    }
  | { isFound: false; reason: MaxLeverageRefusal };

interface ResolveEntryLeverageArgs {
  /** The signal's leverage, or the default (5) when the signal has none. */
  desiredLeverage: number;
  /** Liquidation-beyond-stop guard; null when the entry has no stop (the guard is skipped). */
  stopGuard: Omit<ComputeMaxLeverageBeforeStopArgs, 'maxLeverage'> | null;
  /** Tier-cap fit (fitLeverage); null to skip it. */
  tierFit: Omit<FitLeverageArgs, 'desiredLeverage'> | null;
}

type EntryLeverageLimit = 'desired' | 'stop' | 'tier_cap';

type EntryLeverage =
  | {
      isResolved: true;
      leverage: number;
      limitedBy: EntryLeverageLimit;
      stopGuard: MaxLeverageBeforeStop | null;
      tierFit: LeverageFit | null;
      explanation: string;
    }
  | {
      isResolved: false;
      reason: MaxLeverageRefusal;
      stopGuard: MaxLeverageBeforeStop;
      explanation: string;
    };

export type {
  ComputeMaxLeverageBeforeStopArgs,
  EntryLeverage,
  EntryLeverageLimit,
  EstimateIsolatedLiquidationPriceArgs,
  MaxLeverageBeforeStop,
  MaxLeverageLimit,
  MaxLeverageRefusal,
  ResolveEntryLeverageArgs,
};
