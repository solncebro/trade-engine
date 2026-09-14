/** Puts an amount (contracts) onto the symbol's lot-step grid. Returns the input unchanged for an unknown symbol. */
type AmountStepSnapper = (symbol: string, amount: number) => number;

export type { AmountStepSnapper };
