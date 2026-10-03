import type { BreakevenLadder, ComputeBreakevenLadderArgs } from './breakevenLadder.types';

function computeBreakevenLadder(args: ComputeBreakevenLadderArgs): BreakevenLadder {
  const { fibAvgEntry, totalContracts, orderCount, epsPercent, tickSize, direction } = args;
  const count = Math.max(1, Math.floor(orderCount));
  const rawBase = direction === 'long' ? fibAvgEntry * (1 + epsPercent / 100) : fibAvgEntry * (1 - epsPercent / 100);
  const step = tickSize > 0 ? tickSize : 0;
  const signedStep = direction === 'long' ? step : -step;
  const base = step > 0 ? Math.round(rawBase / step) * step : rawBase;
  const priceList: number[] = [];

  for (let orderIndex = 0; orderIndex < count; orderIndex += 1) {
    priceList.push(base + signedStep * orderIndex);
  }

  const perOrder = totalContracts / count;
  const amountList: number[] = [];
  let allocated = 0;

  for (let orderIndex = 0; orderIndex < count; orderIndex += 1) {
    if (orderIndex === count - 1) {
      amountList.push(totalContracts - allocated);
    } else {
      amountList.push(perOrder);
      allocated += perOrder;
    }
  }

  return { priceList, amountList };
}

// True breakeven price once the fee is paid on BOTH the entry and the exit (f = feePercent / 100;
// the fee is given in percent, e.g. 0.02 for a 0.02 % maker fee):
//   long  — sell proceeds after fee must cover the fee-loaded entry cost → P = avgEntry × (1 + f) / (1 − f).
//   short — buy-back cost with fee must stay within the fee-reduced sell proceeds → P = avgEntry × (1 − f) / (1 + f).
// Returns avgEntry unchanged when the fee is zero or invalid (NaN, negative, 100 % or more).
// Ported from volume-breaker (fibLevels.ts), where it was private to the Fib strategy.
function computeBreakevenWithFees(avgEntry: number, feePercent: number, direction: 'long' | 'short'): number {
  const feeFraction = feePercent / 100;

  if (!Number.isFinite(feeFraction) || feeFraction <= 0 || feeFraction >= 1) {
    return avgEntry;
  }

  if (direction === 'long') {
    return (avgEntry * (1 + feeFraction)) / (1 - feeFraction);
  }

  return (avgEntry * (1 - feeFraction)) / (1 + feeFraction);
}

export { computeBreakevenLadder, computeBreakevenWithFees };
