interface ParseOrderSizeInputArgs {
  text: string;
  minValue: number;
}

interface ParseOrderSizeInputSuccess {
  isValid: true;
  orderSize: number;
}

interface ParseOrderSizeInputFailure {
  isValid: false;
  error: string;
}

type ParseOrderSizeInputResult = ParseOrderSizeInputSuccess | ParseOrderSizeInputFailure;

export type { ParseOrderSizeInputArgs, ParseOrderSizeInputResult };
