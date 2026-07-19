interface ComputeBreakevenLadderArgs {
  fibAvgEntry: number;
  totalContracts: number;
  orderCount: number;
  epsPercent: number;
  tickSize: number;
  direction: 'long' | 'short';
}

interface BreakevenLadder {
  priceList: number[];
  amountList: number[];
}

export type { BreakevenLadder, ComputeBreakevenLadderArgs };
