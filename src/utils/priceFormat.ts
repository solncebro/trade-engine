import { roundToStep } from '@solncebro/exchange-engine';
import type { StepRounding } from '@solncebro/exchange-engine';

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

/**
 * Puts a price onto the symbol's tick grid in the given direction. Returns the input unchanged for an
 * unknown symbol.
 */
type PriceTickSnapper = (symbol: string, price: number, rounding: StepRounding) => number;

/**
 * Tick size the installed grid uses for a symbol, `null` when the symbol is unknown. Installed together
 * with the snapper so both always describe one grid.
 */
type PriceTickSizeReader = (symbol: string) => number | null;

/**
 * Digit cap for a price that could NOT be snapped (no snapper configured, symbol filters not loaded,
 * a snapper that threw): the tick grid of a perpetual never needs more, and it stops an unsnapped
 * value from printing its whole 16-digit tail.
 */
const UNSNAPPED_PRICE_MAX_DIGITS = 8;

/** Rendered in place of a price that does not exist (null/undefined/NaN). */
const ABSENT_PRICE_TEXT = '—';

let tickSnapper: PriceTickSnapper | null = null;
let tickSizeReader: PriceTickSizeReader | null = null;

/**
 * Install the tick-grid source. Called automatically by `ExchangeConnector.initialize()`; call it
 * directly only when there is no connector, or to override. `null` restores the unconfigured state.
 */
function configurePriceTickSnapper(snapper: PriceTickSnapper | null): void {
  tickSnapper = snapper;
  // A new snapper may be a different grid; the old reader would describe a grid that is gone. The
  // installer sets its reader right after, so an unpaired snapper reports an unknown tick instead of a wrong one.
  tickSizeReader = null;
}

/**
 * A snapper over a bare tick-size source, for a place that cannot reach the connector's loaded filters
 * (a worker thread: it has its own module instances). Rounds with the same `roundToStep` the exchange
 * client's `priceToPrecision` ends in, so it lands on the same grid; a symbol without a tick (unknown,
 * `null`, non-positive) comes back unchanged — the connector's snapper treats an unknown symbol the same way.
 */
function createPriceTickSnapper(readTickSize: PriceTickSizeReader): PriceTickSnapper {
  return (symbol, price, rounding) => {
    const tickSize = readTickSize(symbol);

    if (tickSize === null || !Number.isFinite(tickSize) || tickSize <= 0) {
      return price;
    }

    return roundToStep(price, String(tickSize), rounding);
  };
}

/**
 * Install the tick-size source describing the SAME grid as the snapper — call it right after
 * `configurePriceTickSnapper`, which clears it. `null` clears it.
 */
function configurePriceTickSizeReader(reader: PriceTickSizeReader | null): void {
  tickSizeReader = reader;
}

/**
 * Tick size of the currently installed price grid for the symbol; `null` when no grid is installed,
 * the symbol is unknown, or the reader throws. Lets code that cannot share this module's state (a
 * worker thread) rebuild the same grid.
 */
function readPriceTickSize(symbol: string): number | null {
  if (tickSnapper === null || tickSizeReader === null) {
    return null;
  }

  try {
    const tickSize = tickSizeReader(symbol);

    return tickSize !== null && Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null;
  } catch {
    return null;
  }
}

/**
 * The price as the exchange would hold it (`rounding`: closest tick, the tick at or above, or at or
 * below — one rounding for every direction, none of it lives here). An unknown symbol, an unconfigured or a throwing snapper
 * keeps the input: an approximate-but-readable number is never worth breaking a message — or an order
 * path — over.
 */
function snapPriceToTick(symbol: string, price: number, rounding: StepRounding = 'nearest'): number {
  if (tickSnapper === null || !Number.isFinite(price)) {
    return price;
  }

  try {
    const snapped = tickSnapper(symbol, price, rounding);

    return Number.isFinite(snapped) ? snapped : price;
  } catch {
    return price;
  }
}

/** Shortest decimal string of a value: 2.96160000 → "2.9616", 75 → "75". */
function trimNumberTail(value: number, maxDigits: number): string {
  const rounded = Number(value.toFixed(maxDigits));
  const text = String(rounded);

  // String() switches to exponent notation below 1e-6 ("3.4e-7") — a sub-micro coin must still read
  // as a plain decimal, so the fixed form is kept and only its trailing zeros go.
  return text.includes('e') ? rounded.toFixed(maxDigits).replace(/\.?0+$/, '') : text;
}

/**
 * Human-facing price string: tick grid first, then no trailing zeros. An absent price renders as a
 * dash rather than "null"/"NaN" — the operator reads "no price", which is what it means.
 */
function formatPrice(symbol: string, price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    return ABSENT_PRICE_TEXT;
  }

  return trimNumberTail(snapPriceToTick(symbol, price), UNSNAPPED_PRICE_MAX_DIGITS);
}

export {
  ABSENT_PRICE_TEXT,
  configurePriceTickSizeReader,
  configurePriceTickSnapper,
  createPriceTickSnapper,
  formatPrice,
  PriceTickSizeReader,
  PriceTickSnapper,
  readPriceTickSize,
  snapPriceToTick,
  trimNumberTail,
};
