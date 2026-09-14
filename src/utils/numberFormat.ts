import type { AmountStepSnapper } from './numberFormat.types';
import { ABSENT_PRICE_TEXT, trimNumberTail } from './priceFormat';

/**
 * Digit cap for an amount that could NOT be snapped (no snapper configured, symbol filters not
 * loaded): no perpetual lot step needs more, and it stops an unsnapped value from printing its
 * whole floating-point tail.
 */
const UNSNAPPED_AMOUNT_MAX_DIGITS = 8;

/** Account money (USDT sums: notional, margin, balance, PnL) is shown with cents, never finer. */
const USD_AMOUNT_MAX_DIGITS = 2;

const PERCENT_DEFAULT_MAX_DIGITS = 2;

let amountSnapper: AmountStepSnapper | null = null;

/**
 * Install the lot-step source. Called automatically by `ExchangeConnector.initialize()`; call it
 * directly only when there is no connector, or to override. `null` restores the unconfigured state.
 */
function configureAmountStepSnapper(snapper: AmountStepSnapper | null): void {
  amountSnapper = snapper;
}

/** The amount as the exchange would hold it. Unknown symbol / unconfigured or throwing snapper keeps the input. */
function snapAmountToStep(symbol: string, amount: number): number {
  if (amountSnapper === null || !Number.isFinite(amount)) {
    return amount;
  }

  try {
    const snapped = amountSnapper(symbol, amount);

    return Number.isFinite(snapped) ? snapped : amount;
  } catch {
    return amount;
  }
}

/** Human-facing contracts amount: lot-step grid first, then no floating-point tail. */
function formatAmount(symbol: string, amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return ABSENT_PRICE_TEXT;
  }

  return trimNumberTail(snapAmountToStep(symbol, amount), UNSNAPPED_AMOUNT_MAX_DIGITS);
}

/** Human-facing USDT sum (notional, margin, balance, PnL): at most cents, no floating-point tail. */
function formatUsdAmount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ABSENT_PRICE_TEXT;
  }

  return trimNumberTail(value, USD_AMOUNT_MAX_DIGITS);
}

/** Human-facing percent value (without the % sign): a computed ratio never prints its tail. */
function formatPercent(value: number | null | undefined, maxDigits: number = PERCENT_DEFAULT_MAX_DIGITS): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ABSENT_PRICE_TEXT;
  }

  return trimNumberTail(value, maxDigits);
}

/** Cents-rounded USDT sum for a structured log field or a journal row. */
function roundUsdAmount(value: number): number {
  return Number(value.toFixed(USD_AMOUNT_MAX_DIGITS));
}

/** Percent rounded for a structured log field. */
function roundPercent(value: number, maxDigits: number = PERCENT_DEFAULT_MAX_DIGITS): number {
  return Number(value.toFixed(maxDigits));
}

export {
  configureAmountStepSnapper,
  formatAmount,
  formatPercent,
  formatUsdAmount,
  roundPercent,
  roundUsdAmount,
  snapAmountToStep,
};
