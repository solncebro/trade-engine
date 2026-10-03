// Binance USDⓈ-M futures: "-5022 GTX_ORDER_REJECT — Due to the order could not be executed as maker,
// the Post Only order will be rejected." (developers.binance.com/docs/derivatives/usds-margined-futures/error-code)
// The refusal comes back synchronously on the create call, so it lands in OrderResult.errorCode.
const BINANCE_FUTURES_POST_ONLY_REJECT_CODE = -5022;

// Bybit V5 rejectReason enum: "EC_PostOnlyWillTakeLiquidity — your post only order would have executed
// as a taker, and so was rejected" (bybit-exchange.github.io/docs/v5/enum#rejectreason). Bybit accepts
// the order and then drops it, so the reason arrives on the order stream (OrderUpdateEvent.rejectReason).
const BYBIT_POST_ONLY_REJECT_REASON = 'EC_PostOnlyWillTakeLiquidity';

interface PostOnlyRejectionSource {
  /** OrderResult.errorCode / ExchangeError.code — number or its string form. */
  errorCode?: number | string | null;
  /** OrderUpdateEvent.rejectReason. */
  rejectReason?: string | null;
}

/**
 * True when an order was refused ONLY because, as a post-only (maker-only) order, it would have taken
 * liquidity — the book moved under it. A chaser re-prices and tries again; any other refusal is real.
 * Covers Binance futures (sync error -5022) and Bybit (stream reject reason). Binance SPOT post-only
 * (LIMIT_MAKER) and OKX are not covered: their refusal codes were not confirmed from documentation.
 */
function isPostOnlyRejection(source: PostOnlyRejectionSource): boolean {
  if (source.rejectReason === BYBIT_POST_ONLY_REJECT_REASON) {
    return true;
  }

  if (source.errorCode === null || source.errorCode === undefined) {
    return false;
  }

  return Number(source.errorCode) === BINANCE_FUTURES_POST_ONLY_REJECT_CODE;
}

export { isPostOnlyRejection };
export type { PostOnlyRejectionSource };
