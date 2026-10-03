import type { ExchangeClient } from '@solncebro/exchange-engine';

/** What the account holds and what of it is free, USD. */
interface AccountBalanceSnapshot {
  totalUsd: number;
  availableUsd: number;
  /** Margin (futures) or locked amount (spot) in use; never negative. */
  usedUsd: number;
}

/** The part of a connector the balance readers need (`connector.futures` / `connector.spot`). */
type BalanceReadingClient = Pick<ExchangeClient, 'fetchBalances'>;

interface ReadSpotQuoteBalanceArgs {
  client: BalanceReadingClient;
  /** The stablecoin the spot account trades against; default USDT. */
  quoteAsset?: string;
}

export type { AccountBalanceSnapshot, BalanceReadingClient, ReadSpotQuoteBalanceArgs };
