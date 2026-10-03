import type { LeverageTier } from '@solncebro/exchange-engine';

export interface FitLeverageArgs {
  tierList: ReadonlyArray<LeverageTier>;
  /** The leverage the settings ask for. */
  desiredLeverage: number;
  /** The leverage the symbol is known to run on right now (the value this entry was set to, or a fresh
   *  exchange confirmation); null = unknown. */
  currentLeverage: number | null;
  /** A position or entry orders already exist on the symbol: the leverage may only go DOWN from
   *  `currentLeverage`, and with an unknown current value it must not be touched at all. */
  isSymbolBusy: boolean;
  /** The whole entry plan in USD, INCLUDING what is already committed. */
  planUsd: number;
  /** Filled plus resting on the exchange for this symbol — the part of the plan the tier already counts. */
  committedUsd: number;
  /** Free margin of the account; null = the balance could not be read (not a zero balance). */
  freeMarginUsd: number | null;
  /** Converts a tier cap given in base coins (OKX) into USD. */
  price: number;
}

export type LeverageFitVerdict = 'fits' | 'lowered' | 'lowered_partially' | 'capped' | 'no_tiers';

export interface LeverageFit {
  verdict: LeverageFitVerdict;
  /** The leverage the entry should run on. */
  leverage: number;
  /** The desired leverage after clamping to the symbol's maximum and to the current value on a busy symbol. */
  desiredLeverage: number;
  isClampedToSymbolMax: boolean;
  /** Total notional (committed + new orders) the symbol may hold at `leverage`, never below `committedUsd`. */
  allowedUsd: number;
  /** The tier cap at `desiredLeverage`; null without a tier table. */
  capAtDesiredUsd: number | null;
  /** Margin the move to `leverage` needs on top of what is already frozen; null when nothing is lowered. */
  extraMarginUsd: number | null;
  explanation: string;
}

export interface TierCap {
  tier: LeverageTier;
  capUsd: number;
}
