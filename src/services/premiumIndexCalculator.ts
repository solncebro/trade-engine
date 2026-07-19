const PREMIUM_EMA_WINDOW_SEC = 30;

interface FeedArgs {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  markPrice: number;
  timestamp: number;
}

interface PremiumState {
  premiumEma: number;
  lastTimestamp: number;
}

/**
 * Maintains a per-symbol exponential moving average of the Bybit "premium"
 * term used in the official price-limit formula:
 *
 *   PremiumAvg = EMA( MidPrice − Mark, 30s ),  MidPrice = (Ask1 + Bid1) / 2
 *
 * Bybit does not publish this value on any public WebSocket stream for linear
 * USDT perpetuals, so consumers must maintain it themselves from orderbook +
 * mark-price feeds. This calculator is the central place to do that.
 *
 * EMA is computed in continuous time so it tolerates variable update intervals:
 *
 *   α(Δt) = 1 − exp(−Δt / windowSec)
 *   ema_new = ema_prev + α(Δt) × (sample − ema_prev)
 *
 * The first sample initialises the state directly (no smoothing) — there is
 * no prior history to blend with.
 *
 * Public API is sync and lock-free: `feed` is called from the orderbook hot
 * path, `getPremiumAvg` is called by `OrderCalculator.calculatePriceLimitBounds`
 * consumers and other order-construction sites.
 */
export class PremiumIndexCalculator {
  private readonly stateBySymbol: Map<string, PremiumState> = new Map();

  public feed(args: FeedArgs): void {
    const { symbol, bidPrice, askPrice, markPrice, timestamp } = args;

    if (
      !Number.isFinite(bidPrice) ||
      !Number.isFinite(askPrice) ||
      !Number.isFinite(markPrice) ||
      bidPrice <= 0 ||
      askPrice <= 0 ||
      markPrice <= 0 ||
      !Number.isFinite(timestamp)
    ) {
      return;
    }

    const midPrice = (bidPrice + askPrice) / 2;
    const delta = midPrice - markPrice;
    const previousState = this.stateBySymbol.get(symbol);

    if (previousState === undefined) {
      this.stateBySymbol.set(symbol, {
        premiumEma: delta,
        lastTimestamp: timestamp,
      });

      return;
    }

    const intervalSec = (timestamp - previousState.lastTimestamp) / 1000;

    if (intervalSec <= 0) {
      return;
    }

    const alpha = 1 - Math.exp(-intervalSec / PREMIUM_EMA_WINDOW_SEC);
    const updatedEma =
      previousState.premiumEma + alpha * (delta - previousState.premiumEma);

    this.stateBySymbol.set(symbol, {
      premiumEma: updatedEma,
      lastTimestamp: timestamp,
    });
  }

  public getPremiumAvg(symbol: string): number | undefined {
    return this.stateBySymbol.get(symbol)?.premiumEma;
  }

  public clear(): void {
    this.stateBySymbol.clear();
  }
}
