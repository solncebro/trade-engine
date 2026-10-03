import type { StepRounding } from '@solncebro/exchange-engine';

/** Puts an amount (contracts) onto the symbol's lot-step grid in the given direction. Returns the input unchanged for an unknown symbol. */
type AmountStepSnapper = (symbol: string, amount: number, rounding: StepRounding) => number;

export type { AmountStepSnapper };
