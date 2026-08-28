import type { OrderBookLevel } from '@solncebro/exchange-engine';

export interface SliceAskVolumeWithinBandArgs {
  /** Ask side sorted by price ascending (best ask first). */
  askList: ReadonlyArray<OrderBookLevel>;
  /** The price the band is measured from — fixed by the caller, not the current best ask. */
  referencePrice: number;
  /** How far above `referencePrice` a fill may reach, in percent (0.5 = half a percent). */
  bandPercent: number;
  /** Position left to close; the slice never exceeds it. */
  remainingQty: number;
}

export interface AskVolumeSlice {
  /** Quantity resting at or below the boundary, capped by `remainingQty`; 0 when nothing fits. */
  qty: number;
  /** `referencePrice × (1 + bandPercent / 100)` — the highest price a piece may consume. */
  boundaryPrice: number;
  /** Best ask at the moment of the slice; null on an empty ask side. */
  bestAskPrice: number | null;
  /** The best ask already sits above the boundary — the market moved away, nothing fits. */
  isBeyondBand: boolean;
  /** How many levels the slice consumed (fully or partially). */
  levelCount: number;
}
