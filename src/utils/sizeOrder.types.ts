import type { ExchangeClient } from '@solncebro/exchange-engine';

type OrderKind = 'market' | 'limit';

interface AssertSymbolLoadedArgs {
  exchangeClient: ExchangeClient;
  symbol: string;
  orderKind: OrderKind;
}

interface SplitOrderQtyArgs {
  exchangeClient: ExchangeClient;
  symbol: string;
  /** Full BASE contract quantity to split. */
  fullQty: number;
  /** Selects the per-order cap: market → marketMaxQty, limit → maxQty. */
  orderKind: OrderKind;
  /** Override the per-order cap (BASE contracts). Defaults to the symbol's market/limit cap. */
  maxQtyPerOrder?: number;
  /** Override the drop-tail floor. Defaults to the symbol's minQty. */
  minQty?: number;
  /** When the residual tail falls below minQty, shrink the LAST piece so the tail reaches minQty
   *  instead of dropping it (protective/closing orders must never leave unclosable dust).
   *  Falls back to the drop-tail behavior when the shrink would push the last piece below minQty
   *  (callers detect the drop by summing the pieces). Default false. */
  rebalanceTail?: boolean;
}

interface RebalanceTailPiecesArgs {
  exchangeClient: ExchangeClient;
  symbol: string;
  /** The last piece already produced by the split (≥ minQty, ≤ cap). */
  lastPiece: number;
  /** The residual tail below minQty that would otherwise be dropped. */
  tailQty: number;
  minQty: number;
  cap: number;
  stepSize: number;
}

interface RebalancedTailPieces {
  lastPiece: number;
  tailPiece: number;
}

interface SizeOrderArgs {
  exchangeClient: ExchangeClient;
  symbol: string;
  /** FINAL notional in quote currency (USDT). The caller has already applied any leverage. */
  notionalUsd: number;
  price: number;
  orderKind: OrderKind;
  /** Refuse to size when the symbol's TradeSymbol is not loaded (unbounded-order guard). */
  requireLoadedSymbol?: boolean;
  /** Drop pieces whose notional (qty * price) is below the symbol's minNotional. Default false. */
  enforceMinNotional?: boolean;
}

interface SizeOrderResult {
  /** Per-piece BASE contract quantities: precision-applied, cap-respecting, min-qty-filtered. */
  pieceList: number[];
  /** Sum of pieceList. */
  totalContracts: number;
  /** Set when the order is REFUSED (guard); pieceList is [] when present. */
  guardError?: string;
}

interface SizeLegInput {
  /** FINAL notional for THIS leg, quote currency. The caller has already applied any leverage. */
  notionalUsd: number;
  price: number;
}

interface SizeLegListArgs {
  exchangeClient: ExchangeClient;
  symbol: string;
  legList: SizeLegInput[];
  /** Cap selection for any leg that exceeds the per-order cap. Default 'limit'. */
  orderKind?: OrderKind;
  /** Drop legs whose notional is below the symbol's minNotional. Default false. */
  enforceMinNotional?: boolean;
}

interface SizedLeg {
  amount: number;
  price: number;
}

interface SizeLegListResult {
  /** Flattened, ready for OrderManager.enqueueCreateMultiOrderBatch. */
  partList: SizedLeg[];
  totalContracts: number;
  /** Legs/pieces dropped below minQty (or minNotional when enforced) — for logging. */
  droppedCount: number;
}

export type {
  OrderKind,
  AssertSymbolLoadedArgs,
  SplitOrderQtyArgs,
  RebalanceTailPiecesArgs,
  RebalancedTailPieces,
  SizeOrderArgs,
  SizeOrderResult,
  SizeLegInput,
  SizeLegListArgs,
  SizedLeg,
  SizeLegListResult,
};
