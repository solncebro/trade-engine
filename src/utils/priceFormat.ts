/**
 * THE single door every price number goes through before a human sees it — Telegram messages, health
 * alerts, log lines, journal rows, anything.
 *
 * A raw price carries its full floating-point tail ("trigger 2.961579786096256"). Nobody reads that,
 * and it is not even the truth: an order always rests on the symbol's TICK GRID, so the exchange holds
 * 2.9616. Printing the raw value is therefore both unreadable and wrong.
 *
 * Wiring: `ExchangeConnector.initialize()` configures the snapper automatically from its own loaded
 * symbol filters, so an app that initializes a connector gets correct prices for free. An app with no
 * connector (backtest, tooling) can install its own snapper via `configurePriceTickSnapper`.
 */

/** Puts a price onto the symbol's tick grid. Returns the input unchanged for an unknown symbol. */
type PriceTickSnapper = (symbol: string, price: number) => number;

/**
 * Digit cap for a price that could NOT be snapped (no snapper configured, symbol filters not loaded,
 * a snapper that threw): the tick grid of a perpetual never needs more, and it stops an unsnapped
 * value from printing its whole 16-digit tail.
 */
const UNSNAPPED_PRICE_MAX_DIGITS = 8;

/** Rendered in place of a price that does not exist (null/undefined/NaN). */
const ABSENT_PRICE_TEXT = '—';

let tickSnapper: PriceTickSnapper | null = null;

/**
 * Install the tick-grid source. Called automatically by `ExchangeConnector.initialize()`; call it
 * directly only when there is no connector, or to override. `null` restores the unconfigured state.
 */
function configurePriceTickSnapper(snapper: PriceTickSnapper | null): void {
  tickSnapper = snapper;
}

/**
 * The price as the exchange would hold it. An unknown symbol, an unconfigured or a throwing snapper
 * keeps the input: an approximate-but-readable number is never worth breaking a message — or an order
 * path — over.
 */
function snapPriceToTick(symbol: string, price: number): number {
  if (tickSnapper === null || !Number.isFinite(price)) {
    return price;
  }

  try {
    const snapped = tickSnapper(symbol, price);

    return Number.isFinite(snapped) ? snapped : price;
  } catch {
    return price;
  }
}

/** Shortest decimal string of a value: 2.96160000 → "2.9616", 75 → "75". */
function trimPriceTail(value: number, maxDigits: number): string {
  return String(Number(value.toFixed(maxDigits)));
}

/**
 * Human-facing price string: tick grid first, then no trailing zeros. An absent price renders as a
 * dash rather than "null"/"NaN" — the operator reads "no price", which is what it means.
 */
function formatPrice(symbol: string, price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    return ABSENT_PRICE_TEXT;
  }

  return trimPriceTail(snapPriceToTick(symbol, price), UNSNAPPED_PRICE_MAX_DIGITS);
}

export {
  ABSENT_PRICE_TEXT,
  configurePriceTickSnapper,
  formatPrice,
  PriceTickSnapper,
  snapPriceToTick,
};
