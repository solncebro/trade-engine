import { sliceAskVolumeWithinBand } from '../src/utils/orderBookSlice';

const ASK_LIST = [
  { price: 100, quantity: 10 },
  { price: 100.2, quantity: 20 },
  { price: 100.5, quantity: 30 },
  { price: 101, quantity: 40 },
];

describe('sliceAskVolumeWithinBand', () => {
  it('sums the ask liquidity up to the boundary measured from the reference price', () => {
    const slice = sliceAskVolumeWithinBand({ askList: ASK_LIST, referencePrice: 100, bandPercent: 0.5, remainingQty: 1_000 });

    // 100 × 1.005 lands at 100.49999999999999 in floating point — the 100.5 level still belongs.
    expect(slice.qty).toBe(60);
    expect(slice.levelCount).toBe(3);
    expect(slice.bestAskPrice).toBe(100);
    expect(slice.isBeyondBand).toBe(false);
    expect(slice.boundaryPrice).toBeCloseTo(100.5, 9);
  });

  it('anchors the band to the reference, not to the current best ask', () => {
    // The best ask already moved to +0.3%: only the liquidity between +0.3% and +0.5% fits.
    const askList = [
      { price: 100.3, quantity: 5 },
      { price: 100.5, quantity: 7 },
      { price: 100.6, quantity: 9 },
    ];
    const slice = sliceAskVolumeWithinBand({ askList, referencePrice: 100, bandPercent: 0.5, remainingQty: 1_000 });

    expect(slice.qty).toBe(12);
    expect(slice.levelCount).toBe(2);
  });

  it('reports a market that moved beyond the band instead of returning a piece', () => {
    const askList = [{ price: 100.6, quantity: 50 }];
    const slice = sliceAskVolumeWithinBand({ askList, referencePrice: 100, bandPercent: 0.5, remainingQty: 1_000 });

    expect(slice.qty).toBe(0);
    expect(slice.isBeyondBand).toBe(true);
    expect(slice.bestAskPrice).toBe(100.6);
  });

  it('widening the band admits the level that the narrow band rejected', () => {
    const askList = [{ price: 100.8, quantity: 50 }];

    expect(sliceAskVolumeWithinBand({ askList, referencePrice: 100, bandPercent: 0.5, remainingQty: 1_000 }).isBeyondBand).toBe(true);
    expect(sliceAskVolumeWithinBand({ askList, referencePrice: 100, bandPercent: 1, remainingQty: 1_000 }).qty).toBe(50);
  });

  it('never exceeds what is left to close', () => {
    const slice = sliceAskVolumeWithinBand({ askList: ASK_LIST, referencePrice: 100, bandPercent: 0.5, remainingQty: 25 });

    expect(slice.qty).toBe(25);
    expect(slice.levelCount).toBe(2);
  });

  it('returns an empty slice on an empty ask side without flagging the band', () => {
    const slice = sliceAskVolumeWithinBand({ askList: [], referencePrice: 100, bandPercent: 0.5, remainingQty: 10 });

    expect(slice).toMatchObject({ qty: 0, bestAskPrice: null, isBeyondBand: false, levelCount: 0 });
    expect(slice.boundaryPrice).toBeCloseTo(100.5, 9);
  });

  it('returns nothing for a non-positive remainder or reference', () => {
    expect(sliceAskVolumeWithinBand({ askList: ASK_LIST, referencePrice: 100, bandPercent: 0.5, remainingQty: 0 }).qty).toBe(0);
    expect(sliceAskVolumeWithinBand({ askList: ASK_LIST, referencePrice: 0, bandPercent: 0.5, remainingQty: 10 }).qty).toBe(0);
  });

  it('skips empty levels but keeps walking', () => {
    const askList = [
      { price: 100, quantity: 0 },
      { price: 100.1, quantity: 4 },
    ];
    const slice = sliceAskVolumeWithinBand({ askList, referencePrice: 100, bandPercent: 0.5, remainingQty: 100 });

    expect(slice.qty).toBe(4);
    expect(slice.levelCount).toBe(1);
  });
});
