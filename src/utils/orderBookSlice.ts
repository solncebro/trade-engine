import type { AskVolumeSlice, SliceAskVolumeWithinBandArgs } from './orderBookSlice.types';

// `100 × 1.005` evaluates to 100.49999999999999 in floating point, so a level resting exactly
// on the boundary would be excluded by a strict comparison. Prices live on a tick grid, so a
// relative tolerance this small can only ever admit the level that mathematically belongs.
const BOUNDARY_RELATIVE_TOLERANCE = 1e-9;

/**
 * How much can be bought in one go without paying more than `bandPercent` above the
 * reference price: walk the ask side from the best price upwards, summing the quantity of
 * every level whose price stays at or below the boundary, and cap the sum by what is left
 * to close. The band is anchored to `referencePrice`, NOT to the current best ask — if the
 * best ask already sits 0.3% above the reference, a 0.5% band admits only the liquidity
 * between +0.3% and +0.5%, and once the best ask crosses the boundary nothing fits at all
 * (`isBeyondBand`). Pure: no exchange access, no rounding to lot size — the caller snaps
 * the result to the instrument's step.
 */
function sliceAskVolumeWithinBand(args: SliceAskVolumeWithinBandArgs): AskVolumeSlice {
  const { askList, referencePrice, bandPercent, remainingQty } = args;
  const boundaryPrice = referencePrice * (1 + bandPercent / 100);
  const admittedPriceCeiling = boundaryPrice * (1 + BOUNDARY_RELATIVE_TOLERANCE);
  const bestAskPrice = askList.length > 0 ? askList[0].price : null;

  if (bestAskPrice === null || referencePrice <= 0 || remainingQty <= 0) {
    return { qty: 0, boundaryPrice, bestAskPrice, isBeyondBand: false, levelCount: 0 };
  }

  if (bestAskPrice > admittedPriceCeiling) {
    return { qty: 0, boundaryPrice, bestAskPrice, isBeyondBand: true, levelCount: 0 };
  }

  let qty = 0;
  let levelCount = 0;

  for (const level of askList) {
    if (level.price > admittedPriceCeiling) {
      break;
    }

    if (!(level.quantity > 0)) {
      continue;
    }

    levelCount += 1;
    qty += level.quantity;

    if (qty >= remainingQty) {
      qty = remainingQty;
      break;
    }
  }

  return { qty, boundaryPrice, bestAskPrice, isBeyondBand: false, levelCount };
}

export { sliceAskVolumeWithinBand };
