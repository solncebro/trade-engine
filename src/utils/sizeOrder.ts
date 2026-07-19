import type { ExchangeClient } from '@solncebro/exchange-engine';

import type {
  AssertSymbolLoadedArgs,
  OrderKind,
  RebalancedTailPieces,
  RebalanceTailPiecesArgs,
  SizedLeg,
  SizeLegListArgs,
  SizeLegListResult,
  SizeOrderArgs,
  SizeOrderResult,
  SplitOrderQtyArgs,
} from './sizeOrder.types';

/**
 * Strategy-agnostic order-sizing primitive.
 *
 * It turns a FINAL quote-currency notional into validated, exchange-ready BASE
 * contract amounts: notional → contracts → step precision → per-order cap split
 * → min-qty drop-tail → unbounded-symbol guard. It NEVER applies leverage — the
 * caller forms the final notional upstream (that asymmetry is what caused the
 * spot/leverage incident; keeping leverage out of this module is deliberate and
 * structural, see the absence of any `leverage` field in sizeOrder.types).
 *
 * Placement (OrderManager / PositionManager) consumes the resulting base amount;
 * this primitive sits strictly upstream of it.
 */

const MAX_ORDER_SPLIT_PIECES = 1000;

function parseFilterValue(rawValue: string | undefined): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const value = parseFloat(rawValue);

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveCap(
  exchangeClient: ExchangeClient,
  symbol: string,
  orderKind: OrderKind
): number {
  return orderKind === 'market'
    ? exchangeClient.getMarketMaxOrderQty(symbol)
    : exchangeClient.getMaxOrderQty(symbol);
}

function resolveStepSize(exchangeClient: ExchangeClient, symbol: string): number {
  const stepSize = exchangeClient.tradeSymbols.get(symbol)?.filter.stepSize;

  return parseFilterValue(stepSize) ?? 0;
}

/**
 * Snap to step precision, then floor to the cap when round-to-nearest precision
 * overshoots it (`amountToPrecision` uses Math.round, so a chunk equal to the cap
 * can snap ABOVE the cap). The correction can only REDUCE a piece, never raise it,
 * so total filled is ≤ the un-corrected behavior — strictly safer.
 */
function snapWithinCap(
  exchangeClient: ExchangeClient,
  symbol: string,
  rawAmount: number,
  cap: number,
  stepSize: number
): number {
  const snapped = exchangeClient.amountToPrecision(symbol, rawAmount);

  if (snapped <= cap || stepSize <= 0) {
    return snapped;
  }

  let floored = exchangeClient.amountToPrecision(
    symbol,
    Math.floor(cap / stepSize) * stepSize
  );

  while (floored > cap && floored > 0) {
    floored = exchangeClient.amountToPrecision(symbol, floored - stepSize);
  }

  return floored;
}

/**
 * Guard: refuse to size when the symbol's TradeSymbol is not loaded — without it
 * the cap/min-qty filters are unknown and an unbounded order could be sent.
 * Returns the error text, or undefined when the symbol is loaded.
 */
function assertSymbolLoaded(args: AssertSymbolLoadedArgs): string | undefined {
  const { exchangeClient, symbol, orderKind } = args;

  if (exchangeClient.tradeSymbols.has(symbol)) {
    return undefined;
  }

  return `tradeSymbol for ${symbol} not loaded — refusing to send unbounded ${orderKind} order`;
}

const STEP_FLOOR_EPSILON = 1e-9;

/**
 * Reshape the split's final two pieces so the sub-minQty tail grows to (at least) minQty at the
 * expense of the last piece. The tail is minQty rounded UP to the step; the last piece is the
 * remainder rounded DOWN to the step — the total can only shrink by sub-step dust, never grow,
 * so the pieces never oversize a reduce-only order. Returns null when infeasible (the shrunk
 * last piece would fall below minQty, or minQty itself exceeds the cap) — the caller then keeps
 * the drop-tail behavior.
 */
function rebalanceTailPieces(args: RebalanceTailPiecesArgs): RebalancedTailPieces | null {
  const { exchangeClient, symbol, lastPiece, tailQty, minQty, cap, stepSize } = args;
  let tailPiece = exchangeClient.amountToPrecision(symbol, minQty);

  if (tailPiece < minQty && stepSize > 0) {
    tailPiece = exchangeClient.amountToPrecision(symbol, tailPiece + stepSize);
  }

  const rawLast = lastPiece + tailQty - tailPiece;
  const rebalancedLast =
    stepSize > 0
      ? Math.floor(rawLast / stepSize + STEP_FLOOR_EPSILON) * stepSize
      : rawLast;

  if (rebalancedLast < minQty || tailPiece < minQty || tailPiece > cap) {
    return null;
  }

  return { lastPiece: rebalancedLast, tailPiece };
}

/**
 * Canonical splitter (lift of coin-listing's splitMarketQtyByLimit). Splits a
 * BASE contract quantity into per-order pieces ≤ the cap, dropping any tail below
 * minQty. A quantity at or below the cap returns as a single unsplit piece. No
 * usable cap → single unsplit piece (matches "no market cap → no split").
 * With `rebalanceTail`, a tail below minQty is not dropped: the last piece shrinks
 * so the tail reaches minQty (see rebalanceTailPieces) — protective and closing
 * orders must cover the FULL quantity or the shortfall becomes unclosable dust.
 */
function splitOrderQty(args: SplitOrderQtyArgs): number[] {
  const { exchangeClient, symbol, fullQty, orderKind } = args;

  if (!Number.isFinite(fullQty) || fullQty <= 0) {
    return [];
  }

  const cap = args.maxQtyPerOrder ?? resolveCap(exchangeClient, symbol, orderKind);

  if (!Number.isFinite(cap) || cap <= 0 || fullQty <= cap) {
    return [fullQty];
  }

  const minQty = args.minQty ?? exchangeClient.getMinOrderQty(symbol);
  const stepSize = resolveStepSize(exchangeClient, symbol);
  const pieceList: number[] = [];
  let remaining = fullQty;

  while (remaining > 0 && pieceList.length < MAX_ORDER_SPLIT_PIECES) {
    const rawChunk = Math.min(remaining, cap);
    const chunk = snapWithinCap(exchangeClient, symbol, rawChunk, cap, stepSize);

    if (!Number.isFinite(chunk) || chunk <= 0) {
      break;
    }

    if (chunk < minQty) {
      break;
    }

    pieceList.push(chunk);
    remaining -= chunk;

    // A remainder smaller than one quantity step is float noise, not a real tail: it cannot be
    // placed (orders are step-quantized) and must not trigger the tail rebalance below, which
    // would manufacture a dust piece out of arithmetic error (SOXLUSDT: 192.34 at cap 167 leaves
    // a 4e-15 phantom remainder → [167, 25.33, 0.01] instead of [167, 25.34]).
    if (stepSize > 0 && remaining > 0 && remaining < stepSize) {
      remaining = 0;
    }

    if (remaining > 0 && remaining < minQty) {
      break;
    }
  }

  if (args.rebalanceTail && remaining > 0 && remaining < minQty && pieceList.length > 0) {
    const rebalanced = rebalanceTailPieces({
      exchangeClient,
      symbol,
      lastPiece: pieceList[pieceList.length - 1],
      tailQty: remaining,
      minQty,
      cap,
      stepSize,
    });

    if (rebalanced) {
      pieceList[pieceList.length - 1] = rebalanced.lastPiece;
      pieceList.push(rebalanced.tailPiece);
    }
  }

  return pieceList;
}

/**
 * Size a single order from a final notional. notional → contracts → precision →
 * cap split → drop pieces below minQty (and below minNotional when enforced).
 * Returns guardError (and an empty pieceList) when requireLoadedSymbol and the
 * symbol is not loaded.
 */
function sizeOrder(args: SizeOrderArgs): SizeOrderResult {
  const { exchangeClient, symbol, notionalUsd, price, orderKind } = args;

  if (args.requireLoadedSymbol) {
    const guardError = assertSymbolLoaded({ exchangeClient, symbol, orderKind });

    if (guardError) {
      return { pieceList: [], totalContracts: 0, guardError };
    }
  }

  if (
    !Number.isFinite(notionalUsd) ||
    notionalUsd <= 0 ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return { pieceList: [], totalContracts: 0 };
  }

  const fullQty = exchangeClient.amountToPrecision(symbol, notionalUsd / price);
  const minQty = exchangeClient.getMinOrderQty(symbol);
  const minNotional = args.enforceMinNotional
    ? exchangeClient.getMinNotional(symbol)
    : 0;

  const pieceList = splitOrderQty({
    exchangeClient,
    symbol,
    fullQty,
    orderKind,
    minQty,
  }).filter(
    (qty) =>
      qty >= minQty && (minNotional <= 0 || qty * price >= minNotional)
  );

  const totalContracts = pieceList.reduce((sum, qty) => sum + qty, 0);

  return { pieceList, totalContracts };
}

/**
 * Per-leg sizing for ladders / fib grids → a flat partList for
 * OrderManager.enqueueCreateMultiOrderBatch. Each leg carries its own final
 * notional and price; a leg over the cap is split into multiple parts at the
 * same price; legs/pieces below minQty (or minNotional when enforced) are dropped.
 */
function sizeLegList(args: SizeLegListArgs): SizeLegListResult {
  const { exchangeClient, symbol, legList } = args;
  const orderKind: OrderKind = args.orderKind ?? 'limit';
  const minQty = exchangeClient.getMinOrderQty(symbol);
  const minNotional = args.enforceMinNotional
    ? exchangeClient.getMinNotional(symbol)
    : 0;

  const partList: SizedLeg[] = [];
  let droppedCount = 0;

  for (const leg of legList) {
    const { notionalUsd, price } = leg;

    if (
      !Number.isFinite(notionalUsd) ||
      notionalUsd <= 0 ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      droppedCount += 1;
      continue;
    }

    const fullQty = exchangeClient.amountToPrecision(symbol, notionalUsd / price);
    const pieceList = splitOrderQty({
      exchangeClient,
      symbol,
      fullQty,
      orderKind,
      minQty,
    });

    if (pieceList.length === 0) {
      droppedCount += 1;
      continue;
    }

    for (const amount of pieceList) {
      if (amount < minQty || (minNotional > 0 && amount * price < minNotional)) {
        droppedCount += 1;
        continue;
      }

      partList.push({ amount, price });
    }
  }

  const totalContracts = partList.reduce((sum, part) => sum + part.amount, 0);

  return { partList, totalContracts, droppedCount };
}

export {
  MAX_ORDER_SPLIT_PIECES,
  parseFilterValue,
  assertSymbolLoaded,
  splitOrderQty,
  sizeOrder,
  sizeLegList,
};
