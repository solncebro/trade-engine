import type { AccountBalanceSnapshot, BalanceReadingClient, ReadSpotQuoteBalanceArgs } from './accountBalance.types';

import { logger } from '../core/logger';
import { withRetryOn429 } from '../core/withRetryOn429';

const DEFAULT_SPOT_QUOTE_ASSET = 'USDT';

/**
 * What the futures account holds and what of it is free (`connector.futures`). Read fresh on every
 * call — sizing by a stale free number is worse than not sizing. A refused read, or free money the
 * exchange layer could not work out (availableBalanceSource 'unknown'), answers null rather than
 * zeros: an empty balance reads as an emptied account.
 *
 * The margin in use is READ from the exchange (totalInitialMargin), never derived by subtracting one
 * balance from the other: the two are measured differently (Binance already nets the unrealized
 * result into the free balance), so the difference drifts with an open position — on Bybit it came
 * out NEGATIVE on an account holding nothing (rubber, 29.08.2026). The subtraction survives only as a
 * fallback, and never below zero. Ported from rubber TradeEngine.readAccountBalance.
 */
async function readAccountBalance(client: BalanceReadingClient): Promise<AccountBalanceSnapshot | null> {
  try {
    const balances = await withRetryOn429({ fn: () => client.fetchBalances(), contextLabel: 'fetchBalances futures' });

    if (balances.availableBalanceSource === 'unknown') {
      logger.warn('[AccountBalance] the exchange gave no free-balance figure and none could be derived');

      return null;
    }

    const usedUsd = balances.totalInitialMargin ?? balances.totalWalletBalance - balances.totalAvailableBalance;

    return {
      totalUsd: balances.totalWalletBalance,
      availableUsd: balances.totalAvailableBalance,
      usedUsd: Math.max(0, usedUsd),
    };
  } catch (error: unknown) {
    logger.warn({ error }, '[AccountBalance] the futures account balance could not be read');

    return null;
  }
}

/** Free futures margin, USD; null = unreadable (NOT a zero balance). */
async function readFreeMarginUsd(client: BalanceReadingClient): Promise<number | null> {
  return (await readAccountBalance(client))?.availableUsd ?? null;
}

/**
 * The spot account's quote coin (USDT by default) — the money spot entries are paid with. Only that
 * coin: the spot totals of the exchange layer add up balances of DIFFERENT coins in their own units
 * (a bitcoin counted as a dollar), so they are no USD figure. Null when the read fails; a coin the
 * account does not hold is a real zero.
 */
async function readSpotQuoteBalance(args: ReadSpotQuoteBalanceArgs): Promise<AccountBalanceSnapshot | null> {
  const quoteAsset = args.quoteAsset ?? DEFAULT_SPOT_QUOTE_ASSET;

  try {
    const balances = await withRetryOn429({ fn: () => args.client.fetchBalances(), contextLabel: 'fetchBalances spot' });
    const balance = balances.balanceByAsset.get(quoteAsset);

    if (balance === undefined) {
      return { totalUsd: 0, availableUsd: 0, usedUsd: 0 };
    }

    return { totalUsd: balance.total, availableUsd: balance.free, usedUsd: Math.max(0, balance.locked) };
  } catch (error: unknown) {
    logger.warn({ error, quoteAsset }, '[AccountBalance] the spot account balance could not be read');

    return null;
  }
}

export { readAccountBalance, readFreeMarginUsd, readSpotQuoteBalance };
