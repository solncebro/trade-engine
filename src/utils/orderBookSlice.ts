import type { AskVolumeSlice, BookVolumeSlice, SliceAskVolumeWithinBandArgs, SliceBookVolumeWithinBandArgs } from './orderBookSlice.types';

// `100 × 1.005` evaluates to 100.49999999999999 in floating point, so a level resting exactly
// on the boundary would be excluded by a strict comparison. Prices live on a tick grid, so a
// relative tolerance this small can only ever admit the level that mathematically belongs.
const BOUNDARY_RELATIVE_TOLERANCE = 1e-9;

/**
 * How much can be taken from one side of the book in one go without going further than
 * `bandPercent` past the reference price: walk the side from its best price outwards (asks up,
 * bids down), summing the quantity of every level that stays within the boundary, and cap the
 * sum by what is still wanted. The band is anchored to `referencePrice`, NOT to the current best
 * price — if the best ask already sits 0.3% above the reference, a 0.5% band admits only the
 * liquidity between +0.3% and +0.5%, and once the best price crosses the boundary nothing fits
 * at all (`isBeyondBand`). Pure: no exchange access, no rounding to lot size — the caller snaps
 * the result to the instrument's step.
 */
function sliceBookVolumeWithinBand(args: SliceBookVolumeWithinBandArgs): BookVolumeSlice {
  const { side, levelList, referencePrice, bandPercent, remainingQty } = args;
  const direction = side === 'ask' ? 1 : -1;
  const boundaryPrice = referencePrice * (1 + (direction * bandPercent) / 100);
  const admittedBoundary = boundaryPrice * (1 + direction * BOUNDARY_RELATIVE_TOLERANCE);
  const isWithinBoundary = (price: number): boolean => (side === 'ask' ? price <= admittedBoundary : price >= admittedBoundary);
  const bestPrice = levelList.length > 0 ? levelList[0].price : null;

  if (bestPrice === null || referencePrice <= 0 || remainingQty <= 0) {
    return { qty: 0, boundaryPrice, bestPrice, isBeyondBand: false, levelCount: 0 };
  }

  if (!isWithinBoundary(bestPrice)) {
    return { qty: 0, boundaryPrice, bestPrice, isBeyondBand: true, levelCount: 0 };
  }

  let qty = 0;
  let levelCount = 0;

  for (const level of levelList) {
    if (!isWithinBoundary(level.price)) {
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

  return { qty, boundaryPrice, bestPrice, isBeyondBand: false, levelCount };
}

/** The ask side of `sliceBookVolumeWithinBand`, kept under its original name and shape for callers
 *  that already use it. */
function sliceAskVolumeWithinBand(args: SliceAskVolumeWithinBandArgs): AskVolumeSlice {
  const { bestPrice, ...slice } = sliceBookVolumeWithinBand({ side: 'ask', levelList: args.askList, referencePrice: args.referencePrice, bandPercent: args.bandPercent, remainingQty: args.remainingQty });

  return { ...slice, bestAskPrice: bestPrice };
}

export { sliceAskVolumeWithinBand, sliceBookVolumeWithinBand };
