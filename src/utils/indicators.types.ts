interface CalculatePriceRangePercentArgs {
  highestHigh: number;
  lowestLow: number;
  highestHighTimestamp: number;
  lowestLowTimestamp: number;
}

interface ValidateEntryPriceVsLastArgs {
  price: number;
  lastPrice: number;
  direction: 'long' | 'short';
}

export type { CalculatePriceRangePercentArgs, ValidateEntryPriceVsLastArgs };
