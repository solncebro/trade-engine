import type { WalletTypeEnum } from '@solncebro/exchange-engine';

import type { BalanceReadingClient } from './accountBalance.types';

import type { SubAccountGateway } from '../services/subAccountGateway';

interface ReadCapitalBaseArgs {
  /** The master account's futures client (`connector.futures`). */
  masterClient: BalanceReadingClient;
  /** `connector.subAccounts` of the same master account. */
  subAccountGateway: Pick<SubAccountGateway, 'fetchSubAccountBalanceList'>;
  /** Sub-accounts to add (Binance e-mail / Bybit UID). Empty — the master alone. */
  subAccountIdList: string[];
  /** Default USDT. */
  asset?: string;
  /** The sub-accounts' wallet to read; default UsdtFutures (on Bybit the unified account). */
  walletType?: WalletTypeEnum;
}

interface SubAccountCapitalEntry {
  subAccountId: string;
  /** Realized (wallet) balance of the asset; null — not read. */
  walletBalance: number | null;
  errorText: string | null;
}

interface CapitalBaseReading {
  /** Master + every listed sub-account; null when any of them could not be read (a partial sum is no base). */
  totalWalletBalance: number | null;
  masterWalletBalance: number | null;
  masterErrorText: string | null;
  subAccountEntryList: SubAccountCapitalEntry[];
}

export type { CapitalBaseReading, ReadCapitalBaseArgs, SubAccountCapitalEntry };
