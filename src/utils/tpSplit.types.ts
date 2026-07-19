type TpSplitDirection = 'long' | 'short';

type TpSplitMode =
  | { kind: 'absolute'; price2: number }
  | { kind: 'tickStep'; tickSize: number };

interface ParseFirstPriceInputSuccess {
  isValid: true;
  price: number;
}

interface ParseInputFailure {
  isValid: false;
  error: string;
}

type ParseFirstPriceInputResult = ParseFirstPriceInputSuccess | ParseInputFailure;

interface ParseModeInputArgs {
  text: string;
}

type ParseModeInputResult =
  | { isValid: true; kind: 'absolute'; price2: number }
  | { isValid: true; kind: 'percent'; percent: 0 }
  | ParseInputFailure;

interface BuildPriceListArgs {
  price1: number;
  parts: number;
  direction: TpSplitDirection;
  mode: TpSplitMode;
}

type BuildPriceListResult =
  | { isValid: true; priceList: number[] }
  | { isValid: false; error: string };

interface BuildAmountListArgs {
  totalContracts: number;
  parts: number;
  jitter?: () => number;
}

interface BuildAmountListResult {
  amountList: number[];
}

interface ValidatePriceVsLastArgs {
  price: number;
  lastPrice: number;
  direction: TpSplitDirection;
}

export type {
  TpSplitDirection,
  TpSplitMode,
  ParseFirstPriceInputResult,
  ParseModeInputArgs,
  ParseModeInputResult,
  BuildPriceListArgs,
  BuildPriceListResult,
  BuildAmountListArgs,
  BuildAmountListResult,
  ValidatePriceVsLastArgs,
};
