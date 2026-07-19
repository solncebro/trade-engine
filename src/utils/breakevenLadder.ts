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

export { computeBreakevenLadder };
