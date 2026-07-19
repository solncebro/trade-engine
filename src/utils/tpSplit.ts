import { normalizeNumberInput } from './numberInput';
import type {
  BuildAmountListArgs,
  BuildAmountListResult,
  BuildPriceListArgs,
  BuildPriceListResult,
  ParseFirstPriceInputResult,
  ParseModeInputArgs,
  ParseModeInputResult,
  ValidatePriceVsLastArgs,
} from './tpSplit.types';

const PRICE_NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;
const ABSOLUTE_MODE_PATTERN = /^(\d+(?:\.\d+)?)\$?$/;
const PERCENT_MODE_PATTERN = /^(\d+(?:\.\d+)?)%$/;
const JITTER_MIN_FACTOR = 0.9;
const JITTER_RANGE = 0.2;

function parseFirstPriceInput(text: string): ParseFirstPriceInputResult {
  const cleaned = normalizeNumberInput(text);

  if (!PRICE_NUMBER_PATTERN.test(cleaned)) {
    return { isValid: false, error: 'Invalid price — enter a positive number, e.g. `62050.5`' };
  }

  const price = Number(cleaned);

  if (!isFinite(price) || price <= 0) {
    return { isValid: false, error: 'Invalid price — enter a positive number, e.g. `62050.5`' };
  }

  return { isValid: true, price };
}

function parseModeInput(args: ParseModeInputArgs): ParseModeInputResult {
  const cleaned = normalizeNumberInput(args.text);

  const absoluteMatch = cleaned.match(ABSOLUTE_MODE_PATTERN);

  if (absoluteMatch) {
    const price2 = Number(absoluteMatch[1]);

    if (!isFinite(price2) || price2 <= 0) {
      return { isValid: false, error: 'Invalid absolute price — e.g. `62150.75`' };
    }

    return { isValid: true, kind: 'absolute', price2 };
  }

  const percentMatch = cleaned.match(PERCENT_MODE_PATTERN);

  if (percentMatch) {
    const percent = Number(percentMatch[1]);

    if (percent !== 0) {
      return { isValid: false, error: 'only 0% is supported' };
    }

    return { isValid: true, kind: 'percent', percent: 0 };
  }

  return { isValid: false, error: 'Enter `<price>` (e.g. `62150.75`) or `0%`' };
}

function buildPriceList(args: BuildPriceListArgs): BuildPriceListResult {
  const { price1, parts, direction, mode } = args;

  if (mode.kind === 'absolute') {
    const { price2 } = mode;

    if (direction === 'long' && price2 <= price1) {
      return { isValid: false, error: 'Second price must be above first price' };
    }

    if (direction === 'short' && price2 >= price1) {
      return { isValid: false, error: 'Second price must be below first price' };
    }

    if (parts === 1) {
      return { isValid: true, priceList: [price1] };
    }

    const delta = (price2 - price1) / (parts - 1);
    const priceList: number[] = [];

    for (let i = 0; i < parts; i++) {
      priceList.push(price1 + i * delta);
    }

    return { isValid: true, priceList };
  }

  const step = mode.tickSize;
  const priceList: number[] = [];

  for (let i = 0; i < parts; i++) {
    const offset = i * step;
    const price = direction === 'long' ? price1 + offset : price1 - offset;

    priceList.push(price);
  }

  return { isValid: true, priceList };
}

function buildAmountList(args: BuildAmountListArgs): BuildAmountListResult {
  const { totalContracts, parts } = args;
  const jitter = args.jitter ?? Math.random;
  const base = totalContracts / parts;
  const amountList: number[] = [];
  let allocated = 0;

  for (let i = 0; i < parts - 1; i++) {
    const factor = JITTER_MIN_FACTOR + jitter() * JITTER_RANGE;
    const amount = base * factor;

    amountList.push(amount);
    allocated += amount;
  }

  amountList.push(totalContracts - allocated);

  return { amountList };
}

function validatePriceVsLast(args: ValidatePriceVsLastArgs): boolean {
  const { price, lastPrice, direction } = args;

  if (direction === 'long') {
    return price > lastPrice;
  }

  return price < lastPrice;
}

export {
  parseFirstPriceInput,
  parseModeInput,
  buildPriceList,
  buildAmountList,
  validatePriceVsLast,
};
